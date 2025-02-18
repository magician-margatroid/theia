/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    QuickOpenModel, QuickOpenItem, QuickOpenMode, PrefixQuickOpenService,
    OpenerService, KeybindingRegistry, QuickOpenGroupItem, QuickOpenGroupItemOptions, QuickOpenItemOptions,
    QuickOpenHandler, QuickOpenOptions
} from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { FileSearchService, WHITESPACE_QUERY_SEPARATOR } from '../common/file-search-service';
import { CancellationTokenSource } from '@theia/core/lib/common';
import { LabelProvider } from '@theia/core/lib/browser/label-provider';
import { Command } from '@theia/core/lib/common';
import { NavigationLocationService } from '@theia/editor/lib/browser/navigation/navigation-location-service';
import * as fuzzy from '@theia/core/shared/fuzzy';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileSystemPreferences } from '@theia/filesystem/lib/browser';
import { EditorOpenerOptions, EditorWidget, Position, Range } from '@theia/editor/lib/browser';

export const quickFileOpen: Command = {
    id: 'file-search.openFile',
    category: 'File',
    label: 'Open File...'
};

export interface FilterAndRange {
    filter: string;
    range?: Range;
}

// Supports patterns of <path><#|:><line><#|:|,><col?>
const LINE_COLON_PATTERN = /\s?[#:\(](?:line )?(\d*)(?:[#:,](\d*))?\)?\s*$/;

@injectable()
export class QuickFileOpenService implements QuickOpenModel, QuickOpenHandler {

    @inject(KeybindingRegistry)
    protected readonly keybindingRegistry: KeybindingRegistry;
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;
    @inject(OpenerService)
    protected readonly openerService: OpenerService;
    @inject(PrefixQuickOpenService)
    protected readonly quickOpenService: PrefixQuickOpenService;
    @inject(FileSearchService)
    protected readonly fileSearchService: FileSearchService;
    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;
    @inject(NavigationLocationService)
    protected readonly navigationLocationService: NavigationLocationService;
    @inject(MessageService)
    protected readonly messageService: MessageService;
    @inject(FileSystemPreferences)
    protected readonly fsPreferences: FileSystemPreferences;

    /**
     * Whether to hide .gitignored (and other ignored) files.
     */
    protected hideIgnoredFiles: boolean = true;

    /**
     * Whether the dialog is currently open.
     */
    protected isOpen: boolean = false;

    protected filterAndRangeDefault = { filter: '', range: undefined };

    /**
     * Tracks the user file search filter and location range e.g. fileFilter:line:column or fileFilter:line,column
     */
    protected filterAndRange: FilterAndRange = this.filterAndRangeDefault;

    /**
     * The score constants when comparing file search results.
     */
    private static readonly Scores = {
        max: 1000,  // represents the maximum score from fuzzy matching (Infinity).
        exact: 500, // represents the score assigned to exact matching.
        partial: 250 // represents the score assigned to partial matching.
    };

    readonly prefix: string = '...';

    get description(): string {
        return 'Open File';
    }

    getModel(): QuickOpenModel {
        return this;
    }

    getOptions(): QuickOpenOptions {
        let placeholder = 'File name to search (append : to go to line).';
        const keybinding = this.getKeyCommand();
        if (keybinding) {
            placeholder += ` (Press ${keybinding} to show/hide ignored files)`;
        }
        return {
            placeholder,
            fuzzyMatchLabel: {
                enableSeparateSubstringMatching: true
            },
            fuzzyMatchDescription: {
                enableSeparateSubstringMatching: true
            },
            showItemsWithoutHighlight: true,
            onClose: () => {
                this.isOpen = false;
                this.cancelIndicator.cancel();
            }
        };
    }

    isEnabled(): boolean {
        return this.workspaceService.opened;
    }

    open(): void {
        // Triggering the keyboard shortcut while the dialog is open toggles
        // showing the ignored files.
        if (this.isOpen) {
            this.hideIgnoredFiles = !this.hideIgnoredFiles;
        } else {
            this.hideIgnoredFiles = true;
            this.filterAndRange = this.filterAndRangeDefault;
            this.isOpen = true;
        }

        this.quickOpenService.open(this.filterAndRange.filter);
    }

    /**
     * Get a string (suitable to show to the user) representing the keyboard
     * shortcut used to open the quick file open menu.
     */
    protected getKeyCommand(): string | undefined {
        const keyCommand = this.keybindingRegistry.getKeybindingsForCommand(quickFileOpen.id);
        if (keyCommand) {
            // We only consider the first keybinding.
            const accel = this.keybindingRegistry.acceleratorFor(keyCommand[0], '+');
            return accel.join(' ');
        }

        return undefined;
    }

    private cancelIndicator = new CancellationTokenSource();

    public async onType(lookFor: string, acceptor: (items: QuickOpenItem[]) => void): Promise<void> {
        this.cancelIndicator.cancel();
        this.cancelIndicator = new CancellationTokenSource();
        const token = this.cancelIndicator.token;

        const roots = this.workspaceService.tryGetRoots();

        this.filterAndRange = this.splitFilterAndRange(lookFor);
        const fileFilter = this.filterAndRange.filter;

        const alreadyCollected = new Set<string>();
        const recentlyUsedItems: QuickOpenItem[] = [];

        const locations = [...this.navigationLocationService.locations()].reverse();
        for (const location of locations) {
            const uriString = location.uri.toString();
            if (location.uri.scheme === 'file' && !alreadyCollected.has(uriString) && fuzzy.test(fileFilter, uriString)) {
                const item = this.toItem(location.uri, { groupLabel: recentlyUsedItems.length === 0 ? 'recently opened' : undefined, showBorder: false });
                recentlyUsedItems.push(item);
                alreadyCollected.add(uriString);
            }
        }
        if (fileFilter.length > 0) {
            const handler = async (results: string[]) => {
                if (token.isCancellationRequested) {
                    return;
                }
                const fileSearchResultItems: QuickOpenItem[] = [];

                if (results.length <= 0) {
                    acceptor([this.toNoResultsItem()]);
                    return;
                }

                for (const fileUri of results) {
                    if (!alreadyCollected.has(fileUri)) {
                        const item = this.toItem(fileUri);
                        fileSearchResultItems.push(item);
                        alreadyCollected.add(fileUri);
                    }
                }

                // Create a copy of the file search results and sort.
                const sortedResults = fileSearchResultItems.slice();
                sortedResults.sort((a, b) => this.compareItems(a, b));

                // Extract the first element, and re-add it to the array with the group label.
                const first = sortedResults[0];
                sortedResults.shift();
                if (first) {
                    const item = this.toItem(first.getUri()!, { groupLabel: 'file results', showBorder: !!recentlyUsedItems.length });
                    sortedResults.unshift(item);
                }
                // Return the recently used items, followed by the search results.
                acceptor([...recentlyUsedItems, ...sortedResults]);
            };

            this.fileSearchService.find(fileFilter, {
                rootUris: roots.map(r => r.resource.toString()),
                fuzzyMatch: true,
                limit: 200,
                useGitIgnore: this.hideIgnoredFiles,
                excludePatterns: this.hideIgnoredFiles
                    ? Object.keys(this.fsPreferences['files.exclude'])
                    : undefined,
            }, token).then(handler);
        } else {
            if (roots.length !== 0) {
                acceptor(recentlyUsedItems);
            }
        }
    }

    protected getRunFunction(uri: URI): (mode: QuickOpenMode) => boolean {
        return (mode: QuickOpenMode) => {
            if (mode !== QuickOpenMode.OPEN) {
                return false;
            }
            this.openFile(uri);
            return true;
        };
    }

    /**
     * Compare two `QuickOpenItem`.
     *
     * @param a `QuickOpenItem` for comparison.
     * @param b `QuickOpenItem` for comparison.
     * @param member the `QuickOpenItem` object member for comparison.
     */
    protected compareItems(
        a: QuickOpenItem<QuickOpenItemOptions>,
        b: QuickOpenItem<QuickOpenItemOptions>,
        member: 'getLabel' | 'getUri' = 'getLabel'): number {

        /**
         * Normalize a given string.
         *
         * @param str the raw string value.
         * @returns the normalized string value.
         */
        function normalize(str: string): string {
            return str.trim().toLowerCase();
        }

        // Normalize the user query.
        const query: string = normalize(this.filterAndRange.filter);

        /**
         * Score a given string.
         *
         * @param str the string to score on.
         * @returns the score.
         */
        function score(str: string): number {
            // Adjust for whitespaces in the query.
            const querySplit = query.split(WHITESPACE_QUERY_SEPARATOR);
            const queryJoin = querySplit.join('');

            // Check exact and partial exact matches.
            let exactMatch = true;
            let partialMatch = false;
            querySplit.forEach(part => {
                const partMatches = str.includes(part);
                exactMatch = exactMatch && partMatches;
                partialMatch = partialMatch || partMatches;
            });

            // Check fuzzy matches.
            const fuzzyMatch = fuzzy.match(queryJoin, str);
            let matchScore = 0;
            // eslint-disable-next-line no-null/no-null
            if (!!fuzzyMatch && matchScore !== null) {
                matchScore = (fuzzyMatch.score === Infinity) ? QuickFileOpenService.Scores.max : fuzzyMatch.score;
            }

            // Prioritize exact matches, then partial exact matches, then fuzzy matches.
            if (exactMatch) {
                return matchScore + QuickFileOpenService.Scores.exact;
            } else if (partialMatch) {
                return matchScore + QuickFileOpenService.Scores.partial;
            } else {
                // eslint-disable-next-line no-null/no-null
                return (fuzzyMatch === null) ? 0 : matchScore;
            }
        }

        // Get the item's member values for comparison.
        let itemA = a[member]()!;
        let itemB = b[member]()!;

        // If the `URI` is used as a comparison member, perform the necessary string conversions.
        if (typeof itemA !== 'string') {
            itemA = itemA.path.toString();
        }
        if (typeof itemB !== 'string') {
            itemB = itemB.path.toString();
        }

        // Normalize the item labels.
        itemA = normalize(itemA);
        itemB = normalize(itemB);

        // Score the item labels.
        const scoreA: number = score(itemA);
        const scoreB: number = score(itemB);

        // If both label scores are identical, perform additional computation.
        if (scoreA === scoreB) {

            // Favor the label which have the smallest substring index.
            const indexA: number = itemA.indexOf(query);
            const indexB: number = itemB.indexOf(query);

            if (indexA === indexB) {

                // Favor the result with the shortest label length.
                if (itemA.length !== itemB.length) {
                    return (itemA.length < itemB.length) ? -1 : 1;
                }

                // Fallback to the alphabetical order.
                const comparison = itemB.localeCompare(itemA);

                // Compare results by `uri` if necessary.
                if (comparison === 0) {
                    return member === 'getUri'
                        ? 0 // Avoid infinite recursion if we have already compared by `uri`.
                        : this.compareItems(a, b, 'getUri');
                }

                return itemB.localeCompare(itemA);
            }

            return indexA - indexB;
        }

        return scoreB - scoreA;
    }

    openFile(uri: URI): void {
        const options = this.buildOpenerOptions();
        const closedEditor = this.navigationLocationService.closedEditorsStack.find(editor => editor.uri.path.toString() === uri.path.toString());
        this.openerService.getOpener(uri, options)
            .then(opener => opener.open(uri, options))
            .then(widget => {
                // Attempt to restore the editor state if it exists, and no selection is explicitly requested.
                if (widget instanceof EditorWidget && closedEditor && !options.selection) {
                    widget.editor.restoreViewState(closedEditor.viewState);
                }
            })
            .catch(error => this.messageService.error(error));
    }

    protected buildOpenerOptions(): EditorOpenerOptions {
        return { selection: this.filterAndRange.range };
    }

    private toItem(uriOrString: URI | string, group?: QuickOpenGroupItemOptions): QuickOpenItem<QuickOpenItemOptions> {
        const uri = uriOrString instanceof URI ? uriOrString : new URI(uriOrString);
        let description = this.labelProvider.getLongName(uri.parent);
        if (this.workspaceService.isMultiRootWorkspaceOpened) {
            const rootUri = this.workspaceService.getWorkspaceRootUri(uri);
            if (rootUri) {
                description = `${rootUri.displayName} • ${description}`;
            }
        }
        const icon = this.labelProvider.getIcon(uri);
        const iconClass = icon === '' ? undefined : icon + ' file-icon';
        const options: QuickOpenItemOptions = {
            label: this.labelProvider.getName(uri),
            iconClass,
            description,
            tooltip: this.labelProvider.getLongName(uri),
            uri: uri,
            hidden: false,
            run: this.getRunFunction(uri)
        };
        if (group) {
            return new QuickOpenGroupItem<QuickOpenGroupItemOptions>({ ...options, ...group });
        } else {
            return new QuickOpenItem<QuickOpenItemOptions>(options);
        }
    }

    private toNoResultsItem(): QuickOpenItem<QuickOpenItemOptions> {
        const options: QuickOpenItemOptions = {
            label: 'No matching results',
            run: () => false
        };
        return new QuickOpenItem<QuickOpenItemOptions>(options);
    }

    /**
     * Splits the given expression into a structure of search-file-filter and
     * location-range.
     *
     * @param expression patterns of <path><#|:><line><#|:|,><col?>
     */
    protected splitFilterAndRange(expression: string): FilterAndRange {
        let filter = expression;
        let range = undefined;

        // Find line and column number from the expression using RegExp.
        const patternMatch = LINE_COLON_PATTERN.exec(expression);

        if (patternMatch) {
            const line = parseInt(patternMatch[1] ?? '', 10);
            if (Number.isFinite(line)) {
                const lineNumber = line > 0 ? line - 1 : 0;

                const column = parseInt(patternMatch[2] ?? '', 10);
                const startColumn = Number.isFinite(column) && column > 0 ? column - 1 : 0;

                const position = Position.create(lineNumber, startColumn);

                filter = expression.substr(0, patternMatch.index);
                range = Range.create(position, position);
            }
        }

        return { filter, range };
    }
}

// turndown-plugin-gfm ships no type declarations.
declare module 'turndown-plugin-gfm' {
    import type TurndownService from 'turndown';

    export function gfm(turndownService: TurndownService): void;
}

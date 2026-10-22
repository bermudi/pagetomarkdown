/**
 * The extension's message protocol.
 *
 * Two messages travel between the three parts of the extension:
 *
 *   background → content   { action: 'trigger_conversion', options }
 *   content → background   { type: 'DOWNLOAD_MARKDOWN', data }
 *
 * Typing them here means a change on one side breaks the other side at
 * compile time instead of at runtime.
 */

import type { ConversionOptions } from './turndownRules';
import type { PageMetadata } from './metadata';

export interface TriggerConversionMessage {
    action: 'trigger_conversion';
    options: ConversionOptions;
}

export interface DownloadRequestMessage {
    type: 'DOWNLOAD_MARKDOWN';
    data: {
        markdown: string;
        metadata: PageMetadata;
        options: ConversionOptions;
    };
}

export interface DownloadResult {
    success: boolean;
    error?: string;
}

export type ConversionMessage = TriggerConversionMessage | DownloadRequestMessage;

export function isTriggerConversion(message: unknown): message is TriggerConversionMessage {
    return (
        typeof message === 'object' &&
        message !== null &&
        (message as { action?: unknown }).action === 'trigger_conversion'
    );
}

export function isDownloadRequest(message: unknown): message is DownloadRequestMessage {
    return (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'DOWNLOAD_MARKDOWN'
    );
}

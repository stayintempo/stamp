/// <reference types="vite/client" />

// Injected at build time by vite's `define` from package.json's version.
declare const __APP_VERSION__: string;

// Deploy channel, injected by vite from STAMP_CHANNEL: 'prod' | 'staging'.
declare const __APP_CHANNEL__: string;

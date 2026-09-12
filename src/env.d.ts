/// <reference types="astro/client" />

interface Window {
  skopia?: { track?: (event: string, properties: { dimension: string }) => void };
  turnstile?: {
    render: (container: string | HTMLElement, options: { sitekey: string; action: string; theme: "light"; appearance: "interaction-only"; size: "normal" | "compact"; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string;
    reset: (widgetId?: string) => void;
  };
  onTurnstileLoad?: () => void;
}

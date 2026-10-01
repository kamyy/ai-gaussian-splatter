/**
 * The visitor's answer to the privacy banner: whether Google Analytics may run.
 *
 * The answer is kept in localStorage, so it lasts across visits on this browser. The privacy banner and the site
 * header's Privacy settings entry both use it. A change from either one reaches the other straight away, in this tab and
 * in any other open tab of the site. GDPR requires withdrawing consent to be as easy as giving it, which is why Privacy
 * settings can reopen the banner at any time.
 */

"use client";

import { useSyncExternalStore } from "react";

import { GA_MEASUREMENT_ID } from "@/lib/analytics";

const STORAGE_KEY = "analytics-consent";

// The answer as last read or written. It doubles as the only copy when the browser blocks localStorage, so a choice
// still holds for the rest of the visit.
let current: AnalyticsConsent = readStoredConsent();

// Whether gtag.js may have loaded on this page, and so whether a decline has to reload it away. Privacy settings clears
// the answer before the visitor picks again, so this can't be read off current.
let grantedThisPage = current === "granted";

const listeners = new Set<() => void>();

/** "granted" or "denied" once the visitor has answered, and null while the banner is waiting for an answer. */
export type AnalyticsConsent = "granted" | "denied" | null;

function readStoredConsent(): AnalyticsConsent {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "granted" || stored === "denied") {
      return stored;
    }
  } catch {
    // Blocked storage reads as no answer yet.
  }
  return null;
}

function writeStoredConsent(consent: AnalyticsConsent) {
  try {
    if (consent === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, consent);
    }
  } catch {
    // Blocked storage keeps the answer in memory only.
  }
}

/**
 * Expires every Google Analytics cookie (_ga, _ga_<id>). gtag sets them on the widest domain it can, such as
 * .example.com for app.example.com, so each one is expired on the hostname and on every parent domain.
 */
function clearAnalyticsCookies() {
  const names = document.cookie
    .split(";")
    .map(cookie => cookie.split("=")[0].trim())
    .filter(name => name === "_ga" || name.startsWith("_ga_"));
  const labels = window.location.hostname.split(".");
  const domains = ["", ...labels.slice(0, -1).map((_, i) => `; domain=.${labels.slice(i).join(".")}`)];

  for (const name of names) {
    for (const domain of domains) {
      // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and missing from jsdom.
      document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
    }
  }
}

// Google's documented opt-out flag. gtag.js checks it before every hit, so setting it pauses sending straight away and
// clearing it resumes.
function setOptOut(optOut: boolean) {
  if (GA_MEASUREMENT_ID) {
    (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`] = optOut;
  }
}

/**
 * Hands a new answer to every component using the hook, and acts on it for a gtag.js already loaded on this page.
 *
 * - A grant resumes sending.
 * - A cleared answer pauses sending until the visitor picks again, since they may be about to decline.
 * - A decline always expires the analytics cookies, because an earlier page load may have set them. If gtag.js loaded
 *   on this page, the page also reloads, since a loaded gtag.js has no way to unload. The opt-out flag stays set
 *   through the reload, so gtag.js can't rewrite its session cookie as the page unloads.
 */
function applyConsent(next: AnalyticsConsent) {
  const loadedHere = grantedThisPage;
  if (next === "granted") {
    grantedThisPage = true;
  }

  current = next;
  for (const listener of listeners) {
    listener();
  }

  if (next === "granted") {
    setOptOut(false);
  } else if (next === null && loadedHere) {
    setOptOut(true);
  } else if (next === "denied") {
    setOptOut(true);
    clearAnalyticsCookies();
    if (loadedHere) {
      window.location.reload();
    }
  }
}

// Another tab's answer arrives as a storage event. A grant there loads gtag.js here too, and a withdrawal there has to
// stop it here as well.
function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY) {
    applyConsent(readStoredConsent());
  }
}

// One storage listener serves every subscriber, so a withdrawal from another tab reloads this page once.
function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function getSnapshot(): AnalyticsConsent | undefined {
  return current;
}

// The server can't read localStorage. undefined keeps the banner out of the server's HTML, so a returning visitor who
// already answered never sees it flash before hydration.
function getServerSnapshot(): AnalyticsConsent | undefined {
  return undefined;
}

/**
 * consent is undefined until the component has hydrated. setConsent(null) clears the answer, which reopens the banner.
 * An answer given here or in another tab takes effect the same way.
 */
export function useAnalyticsConsent() {
  const consent = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setConsent = (next: AnalyticsConsent) => {
    writeStoredConsent(next);
    applyConsent(next);
  };

  return { consent, setConsent };
}

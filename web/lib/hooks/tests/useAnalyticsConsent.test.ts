import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({ GA_MEASUREMENT_ID: "G-TEST123" }));

// The hook keeps the answer in module state, so each case imports a fresh copy after setting up localStorage.
async function loadHook() {
  vi.resetModules();
  const { useAnalyticsConsent } = await import("../useAnalyticsConsent");
  return useAnalyticsConsent;
}

describe("useAnalyticsConsent", () => {
  let reload: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    window.localStorage.clear();
    delete (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"];
    reload = vi.fn<() => void>();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hostname: "localhost", reload });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
    document.cookie = "_ga=; Max-Age=0; path=/";
  });

  it("has no answer on a first visit, so the banner shows", async () => {
    const useAnalyticsConsent = await loadHook();

    expect(renderHook(() => useAnalyticsConsent()).result.current.consent).toBeNull();
  });

  it("reads an earlier visit's answer", async () => {
    window.localStorage.setItem("analytics-consent", "granted");
    const useAnalyticsConsent = await loadHook();

    expect(renderHook(() => useAnalyticsConsent()).result.current.consent).toBe("granted");
  });

  it("stores an answer and hands it to every component using the hook", async () => {
    const useAnalyticsConsent = await loadHook();
    const banner = renderHook(() => useAnalyticsConsent());
    const headerButton = renderHook(() => useAnalyticsConsent());

    act(() => banner.result.current.setConsent("granted"));

    expect(headerButton.result.current.consent).toBe("granted");
    expect(window.localStorage.getItem("analytics-consent")).toBe("granted");
  });

  it("clears the answer so the banner reopens", async () => {
    window.localStorage.setItem("analytics-consent", "denied");
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => result.current.setConsent(null));

    expect(result.current.consent).toBeNull();
    expect(window.localStorage.getItem("analytics-consent")).toBeNull();
  });

  // Privacy settings clears the answer first, so a withdrawal arrives as null and then "denied".
  it("opts out of gtag, expires the analytics cookies and reloads when a grant is withdrawn", async () => {
    window.localStorage.setItem("analytics-consent", "granted");
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
    document.cookie = "_ga=GA1.1.123; path=/";
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => result.current.setConsent(null));
    act(() => result.current.setConsent("denied"));

    expect((window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"]).toBe(true);
    expect(document.cookie).not.toContain("_ga=");
    expect(reload).toHaveBeenCalledOnce();
  });

  // Another tab's answer arrives only as a storage event, after that tab has written localStorage.
  function answerInAnotherTab(consent: "granted" | "denied") {
    window.localStorage.setItem("analytics-consent", consent);
    window.dispatchEvent(new StorageEvent("storage", { key: "analytics-consent" }));
  }

  it("follows an answer given in another tab", async () => {
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => answerInAnotherTab("granted"));

    expect(result.current.consent).toBe("granted");
  });

  it("stops analytics once when another tab withdraws a grant", async () => {
    window.localStorage.setItem("analytics-consent", "granted");
    const useAnalyticsConsent = await loadHook();
    renderHook(() => useAnalyticsConsent());
    renderHook(() => useAnalyticsConsent());

    act(() => answerInAnotherTab("denied"));

    expect((window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"]).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  // Tab B's grant loads gtag.js in this tab too, so declining here later has to stop it.
  it("stops analytics when this tab withdraws a grant given in another tab", async () => {
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => answerInAnotherTab("granted"));
    act(() => result.current.setConsent("denied"));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("doesn't reload when the visitor declines without having accepted", async () => {
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => result.current.setConsent("denied"));

    expect(reload).not.toHaveBeenCalled();
  });

  // Privacy settings, then a reload, then Decline: gtag.js never loaded on this page, but an earlier one set _ga.
  it("expires cookies an earlier page load set when the visitor declines", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
    document.cookie = "_ga=GA1.1.123; path=/";
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => result.current.setConsent("denied"));

    expect(document.cookie).not.toContain("_ga=");
    expect(reload).not.toHaveBeenCalled();
  });

  it("pauses sending while the banner is reopened, and resumes on a fresh grant", async () => {
    window.localStorage.setItem("analytics-consent", "granted");
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());
    const optOut = () => (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"];

    act(() => result.current.setConsent(null));
    expect(optOut()).toBe(true);

    act(() => result.current.setConsent("granted"));
    expect(optOut()).toBe(false);
  });

  it("keeps the answer for this visit when localStorage is blocked", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const useAnalyticsConsent = await loadHook();
    const { result } = renderHook(() => useAnalyticsConsent());

    act(() => result.current.setConsent("denied"));

    expect(result.current.consent).toBe("denied");
  });
});

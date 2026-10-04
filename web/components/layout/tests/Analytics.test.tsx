import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Analytics } from "../Analytics";

const { isSignedInMock } = vi.hoisted(() => ({ isSignedInMock: vi.fn<() => boolean | undefined>() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isSignedIn: isSignedInMock() }) }));

vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: ({ gaId }: { gaId: string }) => <div data-testid="google-analytics">{gaId}</div>,
}));

const { consentMock, setConsentMock } = vi.hoisted(() => ({
  consentMock: vi.fn<() => "granted" | "denied" | null | undefined>(),
  setConsentMock: vi.fn(),
}));
vi.mock("@/lib/hooks/useAnalyticsConsent", () => ({
  useAnalyticsConsent: () => ({ consent: consentMock(), setConsent: setConsentMock }),
}));

describe("Analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks before loading anything on a first visit", () => {
    consentMock.mockReturnValue(null);
    render(<Analytics gaId="G-TEST123" />);

    expect(screen.getByRole("region", { name: "Privacy choices" })).toBeInTheDocument();
    expect(screen.queryByTestId("google-analytics")).not.toBeInTheDocument();
  });

  it("points a signed-in user to the account menu, and anyone else to the header", () => {
    consentMock.mockReturnValue(null);
    isSignedInMock.mockReturnValue(true);
    const { rerender } = render(<Analytics gaId="G-TEST123" />);
    expect(screen.getByRole("region", { name: "Privacy choices" })).toHaveTextContent("in your account menu");

    isSignedInMock.mockReturnValue(false);
    rerender(<Analytics gaId="G-TEST123" />);
    expect(screen.getByRole("region", { name: "Privacy choices" })).toHaveTextContent("at the top of the page");
  });

  it("passes the visitor's answer on", () => {
    consentMock.mockReturnValue(null);
    render(<Analytics gaId="G-TEST123" />);

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(setConsentMock).toHaveBeenLastCalledWith("granted");

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(setConsentMock).toHaveBeenLastCalledWith("denied");
  });

  it("loads Google Analytics only once the visitor has accepted", () => {
    consentMock.mockReturnValue("granted");
    render(<Analytics gaId="G-TEST123" />);

    expect(screen.getByTestId("google-analytics")).toHaveTextContent("G-TEST123");
    expect(screen.queryByRole("region", { name: "Privacy choices" })).not.toBeInTheDocument();
  });

  it("renders nothing after a decline", () => {
    consentMock.mockReturnValue("denied");
    const { container } = render(<Analytics gaId="G-TEST123" />);

    expect(container).toBeEmptyDOMElement();
  });

  // Before hydration the answer is unknown, and showing the banner then would flash it at visitors who already answered.
  it("renders nothing before hydration", () => {
    consentMock.mockReturnValue(undefined);
    const { container } = render(<Analytics gaId="G-TEST123" />);

    expect(container).toBeEmptyDOMElement();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SplatSubNav } from "./SplatSubNav";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/splats/splat-1/point-cloud",
}));

function renderNav(props: Partial<{ pointCloudEnabled: boolean; splatEnabled: boolean }> = {}) {
  return render(<SplatSubNav splatId="splat-1" pointCloudEnabled={false} splatEnabled={false} {...props} />);
}

describe("SplatSubNav", () => {
  it("disables point cloud and splat when neither asset exists yet", () => {
    // Anything not yet processed has neither. Offering either toggle position would render an empty canvas with
    // nothing to explain it.
    renderNav();
    expect(screen.getByRole("button", { name: "Point cloud" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Splat" })).toBeDisabled();
  });

  it("enables point cloud once a point cloud exists", () => {
    renderNav({ pointCloudEnabled: true });
    expect(screen.getByRole("button", { name: "Point cloud" })).not.toBeDisabled();
  });

  it("enables splat once the splat is complete", () => {
    renderNav({ splatEnabled: true });
    expect(screen.getByRole("button", { name: "Splat" })).not.toBeDisabled();
  });
});

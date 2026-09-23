import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NavMenu } from "./NavMenu";

vi.mock("@clerk/nextjs", () => ({
  Show: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Confirms Radix's DropdownMenu.Item asChild + next/link preserves the roving-tabindex keyboard navigation MUI's
// component={Link} trick used to guarantee — the one behavior most at risk in the Radix swap (see AGENTS.md).
// userEvent (not fireEvent) is required: Radix's trigger opens on pointerdown, which fireEvent.click alone never
// dispatches.
describe("NavMenu", () => {
  it("opens the menu and renders Home and My splats as real links", async () => {
    const user = userEvent.setup();
    render(<NavMenu />);
    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));

    const home = await screen.findByRole("menuitem", { name: /home/i });
    const mySplats = screen.getByRole("menuitem", { name: "My splats" });
    expect(home).toHaveAttribute("href", "/");
    expect(mySplats).toHaveAttribute("href", "/splats");
  });

  it("moves focus between items with arrow keys", async () => {
    const user = userEvent.setup();
    render(<NavMenu />);
    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));

    const home = await screen.findByRole("menuitem", { name: /home/i });
    const mySplats = screen.getByRole("menuitem", { name: "My splats" });

    // jsdom has no real layout, so Radix's own focus-on-open (which checks element visibility via layout) never
    // fires here — focus the first item directly instead, then verify the roving-tabindex group Radix builds from
    // the rendered <a> elements actually moves focus between them, which is the behavior this test exists to check.
    home.focus();
    await user.keyboard("{ArrowDown}");
    expect(mySplats).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(home).toHaveFocus();
  });
});

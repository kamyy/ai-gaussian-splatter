import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Pager, pageItems } from "../Pager";

describe("pageItems", () => {
  it("lists every page when they all fit", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("collapses the far end while the current page is near the start", () => {
    expect(pageItems(1, 8)).toEqual([1, 2, 3, 4, 5, "gap", 8]);
    expect(pageItems(4, 17)).toEqual([1, 2, 3, 4, 5, "gap", 17]);
  });

  it("collapses both ends around a page in the middle", () => {
    expect(pageItems(5, 17)).toEqual([1, "gap", 4, 5, 6, "gap", 17]);
    expect(pageItems(9, 17)).toEqual([1, "gap", 8, 9, 10, "gap", 17]);
  });

  it("collapses the near end while the current page is near the end", () => {
    expect(pageItems(14, 17)).toEqual([1, "gap", 13, 14, 15, 16, 17]);
    expect(pageItems(8, 8)).toEqual([1, "gap", 4, 5, 6, 7, 8]);
  });
});

describe("Pager", () => {
  it("marks the current page and asks for the one clicked", () => {
    const onChange = vi.fn();
    render(<Pager label="Photo pages" current={2} count={3} onChange={onChange} />);
    expect(screen.getByRole("navigation", { name: "Photo pages" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(onChange.mock.calls).toEqual([[1], [3], [3]]);
  });

  it("disables previous on the first page and next on the last", () => {
    const { rerender } = render(<Pager label="Photo pages" current={1} count={3} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();

    rerender(<Pager label="Photo pages" current={3} count={3} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("collapses a long run of pages", () => {
    render(<Pager label="Photo pages" current={9} count={17} onChange={() => {}} />);
    const pages = screen.getAllByRole("button", { name: /^Page / }).map(button => button.textContent);
    expect(pages).toEqual(["1", "8", "9", "10", "17"]);
  });

  it("flags the marked page, or the ellipsis hiding it", () => {
    const { container, rerender } = render(
      <Pager label="Photo pages" current={3} count={9} onChange={() => {}} markedPage={2} />,
    );
    expect(screen.getByRole("button", { name: "Page 2, has the selected photo" })).toBeInTheDocument();

    rerender(<Pager label="Photo pages" current={3} count={9} onChange={() => {}} markedPage={7} />);
    expect(screen.queryByRole("button", { name: /has the selected photo/ })).not.toBeInTheDocument();

    // The pages run 1 to 5, then an ellipsis for 6 to 8, then 9.
    const gap = [...container.querySelectorAll("span")].find(span => span.textContent === "…");
    expect(gap?.querySelector("svg")).not.toBeNull();
  });

  it("tints pages holding unplaced photos and counts them, or the ellipsis hiding them", () => {
    const { container, rerender } = render(
      <Pager
        label="Photo pages"
        current={3}
        count={9}
        onChange={() => {}}
        flaggedByPage={new Map([[2, 2]])}
        flagDescription="couldn't be placed"
      />,
    );
    const flagged = screen.getByRole("button", { name: "Page 2, 2 photos couldn't be placed" });
    expect(flagged).toHaveTextContent("22");
    expect(screen.getByRole("button", { name: "Page 3" })).toHaveTextContent(/^3$/);

    // The pages run 1 to 5, then an ellipsis for 6 to 8, then 9.
    rerender(
      <Pager
        label="Photo pages"
        current={3}
        count={9}
        onChange={() => {}}
        flaggedByPage={
          new Map([
            [6, 1],
            [8, 3],
          ])
        }
      />,
    );
    const gap = [...container.querySelectorAll("span")].find(span => span.textContent?.startsWith("…"));
    expect(gap).toHaveTextContent("…4");
  });

  it("steps pages with the arrow keys and jumps with Home and End, focusing the new page", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Pager label="Photo pages" current={2} count={9} onChange={onChange} />);
    const page2 = screen.getByRole("button", { name: "Page 2" });

    fireEvent.keyDown(page2, { key: "ArrowRight" });
    fireEvent.keyDown(page2, { key: "ArrowLeft" });
    fireEvent.keyDown(page2, { key: "End" });
    fireEvent.keyDown(page2, { key: "Home" });
    expect(onChange.mock.calls).toEqual([[3], [1], [9], [1]]);

    rerender(<Pager label="Photo pages" current={1} count={9} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveFocus();
  });

  it("ignores a key that would go past either end", () => {
    const onChange = vi.fn();
    render(<Pager label="Photo pages" current={1} count={3} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Page 1" }), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

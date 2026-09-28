import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Pager } from "./Pager";

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
});

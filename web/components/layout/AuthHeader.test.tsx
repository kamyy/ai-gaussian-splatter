import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Splat } from "@/lib/types";
import { AuthHeader } from "./AuthHeader";

vi.mock("@clerk/nextjs", () => ({
  UserButton: () => <div data-testid="user-button" />,
}));

const { useParamsMock } = vi.hoisted(() => ({ useParamsMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: useParamsMock }));

const { useSplatMock } = vi.hoisted(() => ({ useSplatMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useSplat: useSplatMock }));

const baseSplat: Splat = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ceramic mug",
  status: "processing",
  thumbnailS3Key: null,
  isShareable: false,
  createdAt: "2026-01-01T00:00:00Z",
};

function renderHeader() {
  return render(<AuthHeader />);
}

describe("AuthHeader", () => {
  it("shows no splat chip on a route with no splat", () => {
    useParamsMock.mockReturnValue({});
    useSplatMock.mockReturnValue({ data: undefined });
    renderHeader();

    expect(useSplatMock).toHaveBeenCalledWith(null);
    expect(screen.queryByText("Ceramic mug")).not.toBeInTheDocument();
  });

  it("shows the current splat's name on a splat sub-route", () => {
    useParamsMock.mockReturnValue({ id: baseSplat.id });
    useSplatMock.mockReturnValue({ data: baseSplat });
    renderHeader();

    expect(useSplatMock).toHaveBeenCalledWith(baseSplat.id);
    expect(screen.getByText("Ceramic mug")).toBeInTheDocument();
  });

  it("always renders the user button", () => {
    useParamsMock.mockReturnValue({});
    useSplatMock.mockReturnValue({ data: undefined });
    renderHeader();

    expect(screen.getByTestId("user-button")).toBeInTheDocument();
  });
});

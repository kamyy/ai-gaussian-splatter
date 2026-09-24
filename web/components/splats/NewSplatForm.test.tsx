import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewSplatForm } from "./NewSplatForm";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

const { uploadPhotosMock } = vi.hoisted(() => ({ uploadPhotosMock: vi.fn() }));
vi.mock("@/lib/uploadPhotos", () => ({ uploadPhotos: uploadPhotosMock }));

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("swr", () => ({ mutate: mutateMock }));

const { enqueueSnackbarMock } = vi.hoisted(() => ({ enqueueSnackbarMock: vi.fn() }));
vi.mock("@/lib/useAppSnackbar", () => ({ useAppSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }) }));

// jsdom has no object URLs.
URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();

function submitButton() {
  return screen.getByRole("button", { name: "Upload and start" });
}

// react-dropzone resolves a file selection asynchronously (it's Promise-based internally), so this waits for the file
// to land in component state before the caller goes on to submit.
async function addPhotos(...names: string[]) {
  const files = names.map(name => new File(["fake"], name, { type: "image/jpeg" }));
  fireEvent.change(screen.getByLabelText("Photos"), { target: { files } });
  await waitFor(() => expect(screen.getByRole("img", { name: names[names.length - 1] })).toBeInTheDocument());
}

function fillName(value: string) {
  fireEvent.change(screen.getByLabelText("What are you capturing?"), { target: { value } });
}

describe("NewSplatForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation(async (path: string) => (path === "/api/v1/splats" ? { id: "new-splat-1" } : {}));
    uploadPhotosMock.mockResolvedValue(undefined);
  });

  it("needs both a name and at least one photo", async () => {
    render(<NewSplatForm />);
    expect(submitButton()).toBeDisabled();

    fillName("Coffee mug");
    expect(submitButton()).toBeDisabled();

    await addPhotos("a.jpg");
    expect(submitButton()).not.toBeDisabled();
  });

  it("creates the splat with a trimmed name, uploads, starts processing, and navigates to it", async () => {
    render(<NewSplatForm />);
    fillName("  Coffee mug  ");
    await addPhotos("a.jpg", "b.jpg");
    fireEvent.click(submitButton());

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats", "POST", "test-token", { name: "Coffee mug" });
    expect(uploadPhotosMock).toHaveBeenCalledWith("new-splat-1", expect.any(Array), "test-token");
    expect(uploadPhotosMock.mock.calls[0][1]).toHaveLength(2);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/new-splat-1/process", "POST", "test-token");
    expect(mutateMock).toHaveBeenCalledWith("splats");
  });

  it("ignores the same photo picked twice and lets one be removed", async () => {
    render(<NewSplatForm />);
    await addPhotos("a.jpg", "b.jpg");
    await addPhotos("a.jpg");
    expect(screen.getByText("2 photos added")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove a.jpg" }));
    expect(screen.getByText("1 photo added")).toBeInTheDocument();
  });

  it("surfaces a creation failure and stays on the form", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Name already taken"));
    render(<NewSplatForm />);
    fillName("Coffee mug");
    await addPhotos("a.jpg");
    fireEvent.click(submitButton());

    await waitFor(() => expect(enqueueSnackbarMock).toHaveBeenCalledWith("Name already taken", { variant: "error" }));
    expect(uploadPhotosMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("says the splat was created when the upload fails, and reuses it on retry", async () => {
    uploadPhotosMock.mockRejectedValueOnce(new Error("S3 upload failed: Forbidden"));
    render(<NewSplatForm />);
    fillName("Coffee mug");
    await addPhotos("a.jpg");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(enqueueSnackbarMock).toHaveBeenCalledWith(
        expect.stringMatching(/"Coffee mug" was created, but photo upload failed/i),
        { variant: "error" },
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    const creates = apiFetchMock.mock.calls.filter(([path]) => path === "/api/v1/splats");
    expect(creates).toHaveLength(1);
  });

  it("still navigates to the splat when starting processing fails", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/v1/splats") {
        return { id: "new-splat-1" };
      }
      throw new Error("Need at least 20 uploaded photos, have 1");
    });
    render(<NewSplatForm />);
    fillName("Coffee mug");
    await addPhotos("a.jpg");
    fireEvent.click(submitButton());

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Need at least 20 uploaded photos, have 1", { variant: "error" });
  });
});

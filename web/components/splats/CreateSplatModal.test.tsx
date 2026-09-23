import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateSplatModal } from "./CreateSplatModal";

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

function renderModal(onClose = vi.fn()) {
  render(<CreateSplatModal opened onClose={onClose} />);
  return onClose;
}

describe("CreateSplatModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({ id: "new-splat-1" });
    uploadPhotosMock.mockResolvedValue(undefined);
  });

  it("disables Create until a name is entered", () => {
    renderModal();
    expect(screen.getByRole("heading", { name: "Create new splat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee mug" } });
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
  });

  it("creates the splat, revalidates the carousel's list, and navigates to it", async () => {
    const onClose = renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee mug" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));

    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats", "POST", "test-token", { name: "Coffee mug" });
    expect(mutateMock).toHaveBeenCalledWith("splats");
    expect(onClose).toHaveBeenCalled();
    expect(uploadPhotosMock).not.toHaveBeenCalled();
  });

  it("surfaces a creation failure instead of closing the modal", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Name already taken"));
    const onClose = renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee mug" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(enqueueSnackbarMock).toHaveBeenCalledWith("Name already taken", { variant: "error" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("trims the name before sending it to the API", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Coffee mug  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats", "POST", "test-token", { name: "Coffee mug" }),
    );
  });

  it("surfaces a photo-upload failure without hiding that the splat was already created", async () => {
    // The splat POST already succeeded by the time photo upload can fail, so the error must say so instead of
    // implying nothing happened — and must not re-navigate/close as if upload had succeeded.
    uploadPhotosMock.mockRejectedValueOnce(new Error("S3 upload failed: Forbidden"));
    const onClose = renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee mug" } });

    const file = new File(["fake"], "photo.jpg", { type: "image/jpeg" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    // react-dropzone resolves the file selection asynchronously (it's Promise-based internally), so this waits for
    // it to land in component state before Create is clicked, rather than racing it.
    await waitFor(() => expect(screen.getByText("1 photo selected")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(enqueueSnackbarMock).toHaveBeenCalledWith(
        expect.stringMatching(/"Coffee mug" was created, but photo upload failed/i),
        { variant: "error" },
      ),
    );
    expect(mutateMock).toHaveBeenCalledWith("splats");
    expect(onClose).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("revalidates the splats list and the new splat's photos after a successful upload", async () => {
    const onClose = renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee mug" } });

    const file = new File(["fake"], "photo.jpg", { type: "image/jpeg" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("1 photo selected")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    expect(mutateMock).toHaveBeenCalledWith("splats");
    expect(mutateMock).toHaveBeenCalledWith(["photos", "new-splat-1"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("reuses the already-created splat on retry instead of re-POSTing a duplicate", async () => {
    // The first Create click creates the splat successfully but fails to upload the photo. A retry click must not
    // send a second POST /api/v1/splats for the same name.
    uploadPhotosMock.mockRejectedValueOnce(new Error("S3 upload failed: Forbidden"));
    renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee mug" } });

    const file = new File(["fake"], "photo.jpg", { type: "image/jpeg" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("1 photo selected")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalledTimes(2));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(uploadPhotosMock).toHaveBeenNthCalledWith(2, "new-splat-1", [file], "test-token");
  });
});

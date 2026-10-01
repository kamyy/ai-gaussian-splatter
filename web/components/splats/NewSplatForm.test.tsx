import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewSplatForm } from "./NewSplatForm";

const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: getTokenMock }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

const { uploadPhotosMock } = vi.hoisted(() => ({ uploadPhotosMock: vi.fn() }));
vi.mock("@/lib/uploadPhotos", () => ({ uploadPhotos: uploadPhotosMock }));

const { measurePhotosMock } = vi.hoisted(() => ({ measurePhotosMock: vi.fn() }));
vi.mock("@/lib/measurePhoto", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/measurePhoto")>()),
  measurePhotos: measurePhotosMock,
}));

// jsdom does no layout, so the preview area reports a fixed width. At 800 wide with the default 16px root font, a row
// holds five 4:3 previews at 115.2px tall, so a page of four rows holds 20.
vi.mock("@/lib/hooks/useElementWidth", () => ({ useElementWidth: () => [() => {}, 800] }));

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("swr", () => ({ mutate: mutateMock }));

const { enqueueSnackbarMock } = vi.hoisted(() => ({ enqueueSnackbarMock: vi.fn() }));
vi.mock("@/lib/hooks/useAppSnackbar", () => ({ useAppSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }) }));

const { processingPausedMock } = vi.hoisted(() => ({ processingPausedMock: vi.fn(() => false) }));
vi.mock("@/lib/hooks/useProcessingPaused", () => ({ useProcessingPaused: processingPausedMock }));

// jsdom has no object URLs.
URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();

function submitButton() {
  return screen.getByRole("button", { name: "Upload and start" });
}

// react-dropzone resolves a file selection asynchronously (it's Promise-based internally), and the form then measures
// the photos. This waits for both to finish before the caller goes on.
async function addPhotos(...names: string[]) {
  const drops = measurePhotosMock.mock.calls.length;
  const files = names.map(name => new File(["fake"], name, { type: "image/jpeg" }));
  fireEvent.change(screen.getByLabelText("Photos"), { target: { files } });
  await waitFor(() => expect(measurePhotosMock).toHaveBeenCalledTimes(drops + 1));
  await waitFor(() => expect(screen.queryByText("Reading photos…")).not.toBeInTheDocument());
}

function fillName(value: string) {
  fireEvent.change(screen.getByLabelText("What are you capturing?"), { target: { value } });
}

describe("NewSplatForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processingPausedMock.mockReturnValue(false);
    apiFetchMock.mockImplementation(async (path: string) => (path === "/api/v1/splats" ? { id: "new-splat-1" } : {}));
    uploadPhotosMock.mockResolvedValue(undefined);
    getTokenMock.mockResolvedValue("test-token");
    measurePhotosMock.mockImplementation(async (files: File[]) =>
      files.map(file => ({
        file,
        width: 4032,
        height: 3024,
        thumbnail: new Blob([file.name]),
        takenAt: 0,
        sharpness: 100,
      })),
    );
  });

  it("marks a low-resolution photo and removes every marked one on request", async () => {
    measurePhotosMock.mockImplementation(async (files: File[]) =>
      files.map(file => ({
        file,
        width: file.name.startsWith("small") ? 1200 : 4032,
        height: 900,
        thumbnail: new Blob([file.name]),
        takenAt: 0,
        sharpness: 100,
      })),
    );
    render(<NewSplatForm />);
    await addPhotos("a.jpg", "small-1.jpg", "small-2.jpg");

    expect(screen.getByRole("img", { name: "small-1.jpg: Low resolution (under 1600px)" })).toHaveTextContent(
      "Low res",
    );
    expect(screen.getByText(/2 photos look blurry or low resolution/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove them" }));
    expect(screen.getByText("1 photo added")).toBeInTheDocument();
    expect(screen.queryByText(/blurry or low resolution/)).not.toBeInTheDocument();
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
    expect(uploadPhotosMock).toHaveBeenCalledWith("new-splat-1", expect.any(Array), "test-token", expect.any(Function));
    expect(uploadPhotosMock.mock.calls[0][1]).toEqual([
      expect.objectContaining({ width: 4032, height: 3024 }),
      expect.objectContaining({ width: 4032, height: 3024 }),
    ]);
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

  it("turns away a photo the browser can't read, naming it", async () => {
    measurePhotosMock.mockImplementation(async (files: File[]) =>
      files.map(file => (file.name.endsWith(".heic") ? null : { file, width: 4032, height: 3024 })),
    );
    render(<NewSplatForm />);
    fireEvent.change(screen.getByLabelText("Photos"), {
      target: {
        files: [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.heic", { type: "image/heic" })],
      },
    });

    await waitFor(() => expect(screen.getByText("1 photo added")).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: "b.heic" })).not.toBeInTheDocument();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Couldn't read photo", {
      variant: "error",
      detail: "Try exporting b.heic as JPEG.",
    });
  });

  it("shows the button busy as soon as it's clicked, before the session token arrives", async () => {
    let resolveToken: (token: string) => void = () => {};
    getTokenMock.mockReturnValueOnce(new Promise<string>(resolve => (resolveToken = resolve)));
    render(<NewSplatForm />);
    fillName("Coffee mug");
    await addPhotos("a.jpg");
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitButton()).toHaveAttribute("aria-busy", "true"));
    expect(apiFetchMock).not.toHaveBeenCalled();

    resolveToken("test-token");
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
  });

  it("holds the submit button until every dropped photo has been measured", async () => {
    let finishMeasuring: () => void = () => {};
    measurePhotosMock.mockImplementationOnce(
      (files: File[]) =>
        new Promise(resolve => {
          finishMeasuring = () =>
            resolve(
              files.map(file => ({ file, width: 4032, height: 3024, thumbnail: new Blob([file.name]), takenAt: 0 })),
            );
        }),
    );
    render(<NewSplatForm />);
    fillName("Coffee mug");
    fireEvent.change(screen.getByLabelText("Photos"), {
      target: { files: [new File(["a"], "a.jpg", { type: "image/jpeg" })] },
    });

    await waitFor(() => expect(screen.getByText("Reading photos…")).toBeInTheDocument());
    expect(submitButton()).toBeDisabled();

    finishMeasuring();
    await waitFor(() => expect(submitButton()).not.toBeDisabled());
    expect(screen.getByText("1 photo added")).toBeInTheDocument();
  });

  it("sizes each preview to fill its row", async () => {
    render(<NewSplatForm />);
    await addPhotos("a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg");
    const tile = screen.getByRole("img", { name: "a.jpg" }).closest("li");
    expect(tile).toHaveStyle({ width: "153.6px", height: "115.2px" });

    // The preview shows the photo's thumbnail, not the full file.
    const createObjectURL = vi.mocked(URL.createObjectURL);
    expect(createObjectURL.mock.calls.some(([source]) => source instanceof Blob && !(source instanceof File))).toBe(
      true,
    );
    expect(createObjectURL.mock.calls.every(([source]) => !(source instanceof File))).toBe(true);

    // A placeholder icon sits under each preview until it decodes.
    expect(tile?.querySelector("svg + span img")).not.toBeNull();
  });

  it("enlarges the preview the pointer rests on and shrinks it when the pointer leaves", async () => {
    render(<NewSplatForm />);
    // A full page of four rows, so the area is tall enough for the enlarged photo.
    await addPhotos("a.jpg", ...Array.from({ length: 19 }, (_, i) => `${i + 2}.jpg`));
    const photo = screen.getByRole("img", { name: "a.jpg" }).parentElement as HTMLElement;
    const tile = photo.closest("li") as HTMLElement;

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(tile);
      act(() => void vi.advanceTimersByTime(399));
      expect(photo).toHaveStyle({ width: "153.6px", height: "115.2px" });

      act(() => void vi.advanceTimersByTime(1));
      expect(photo).toHaveStyle({ width: "384px", height: "288px" });

      fireEvent.pointerLeave(tile);
      expect(photo).toHaveStyle({ left: "0px", top: "0px", width: "153.6px", height: "115.2px" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a preview at its size while the pointer rests on its remove button", async () => {
    render(<NewSplatForm />);
    await addPhotos("a.jpg", ...Array.from({ length: 19 }, (_, i) => `${i + 2}.jpg`));
    const photo = screen.getByRole("img", { name: "a.jpg" }).parentElement as HTMLElement;
    const tile = photo.closest("li") as HTMLElement;
    const remove = screen.getByRole("button", { name: "Remove a.jpg" });

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(tile);
      act(() => void vi.advanceTimersByTime(200));
      // React derives enter and leave from the out event of the element being left, with relatedTarget as the one
      // entered.
      fireEvent.pointerOut(photo, { relatedTarget: remove });
      act(() => void vi.advanceTimersByTime(1000));
      expect(photo).toHaveStyle({ width: "153.6px", height: "115.2px" });

      // Back on the photo, the wait starts again.
      fireEvent.pointerOut(remove, { relatedTarget: photo });
      act(() => void vi.advanceTimersByTime(400));
      expect(photo).toHaveStyle({ width: "384px", height: "288px" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pages the previews by whole rows, starting on page 1 after each drop", async () => {
    render(<NewSplatForm />);
    await addPhotos(...Array.from({ length: 21 }, (_, i) => `${i + 1}.jpg`));
    expect(screen.getByText("1–20 of 21")).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(screen.getAllByRole("img").map(img => img.getAttribute("alt"))).toEqual(["21.jpg"]);

    // The part-filled last page keeps a full page's height, four 115.2px rows and three 8px gaps, so the pager stays
    // put.
    expect(screen.getAllByRole("list").at(-1)?.parentElement).toHaveStyle({ minHeight: "484.8px" });

    await addPhotos("22.jpg");
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
  });

  it("moves back a page when the last photo on the final page is removed", async () => {
    render(<NewSplatForm />);
    await addPhotos(...Array.from({ length: 21 }, (_, i) => `${i + 1}.jpg`));
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 21.jpg" }));

    expect(screen.getAllByRole("img")).toHaveLength(20);
    expect(screen.queryByRole("navigation", { name: "Photo pages" })).not.toBeInTheDocument();
  });

  it("orders the previews oldest taken first, whatever order they were added in", async () => {
    const takenAt: Record<string, number> = { "b.jpg": 2, "c.jpg": 3, "a.jpg": 1 };
    measurePhotosMock.mockImplementation(async (files: File[]) =>
      files.map(file => ({
        file,
        width: 4032,
        height: 3024,
        thumbnail: new Blob([file.name]),
        takenAt: takenAt[file.name],
      })),
    );
    render(<NewSplatForm />);
    await addPhotos("c.jpg", "b.jpg");
    await addPhotos("a.jpg");
    expect(screen.getAllByRole("img").map(img => img.getAttribute("alt"))).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("surfaces a creation failure and stays on the form", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Name already taken"));
    render(<NewSplatForm />);
    fillName("Coffee mug");
    await addPhotos("a.jpg");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(enqueueSnackbarMock).toHaveBeenCalledWith("Couldn't create the splat", {
        variant: "error",
        detail: "Name already taken",
      }),
    );
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
      expect(enqueueSnackbarMock).toHaveBeenCalledWith("Photo upload failed", {
        variant: "error",
        detail: '"Coffee mug" was created. S3 upload failed: Forbidden',
      }),
    );
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    const creates = apiFetchMock.mock.calls.filter(([path]) => path === "/api/v1/splats");
    expect(creates).toHaveLength(1);
  });

  it("retries only the photos that didn't upload", async () => {
    uploadPhotosMock.mockImplementationOnce(async (_splatId, photos, _token, onUploaded) => {
      onUploaded(photos[0]);
      throw new Error("1 of 2 photo uploads failed");
    });
    render(<NewSplatForm />);
    fillName("Coffee mug");
    await addPhotos("a.jpg", "b.jpg");
    fireEvent.click(submitButton());
    await waitFor(() => expect(enqueueSnackbarMock).toHaveBeenCalled());

    // Removing an uploaded photo here wouldn't take it off the server, so only the failed one can be removed.
    expect(screen.queryByRole("button", { name: "Remove a.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "a.jpg uploaded" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove b.jpg" })).toBeInTheDocument();

    fireEvent.click(submitButton());
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    const retried = uploadPhotosMock.mock.calls[1][1] as { file: File }[];
    expect(retried.map(photo => photo.file.name)).toEqual(["b.jpg"]);
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
    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Couldn't start processing", {
      variant: "error",
      detail: "Need at least 20 uploaded photos, have 1",
    });
  });

  it("warns while processing is paused, and uploads without trying to start", async () => {
    processingPausedMock.mockReturnValue(true);
    render(<NewSplatForm />);

    expect(screen.getByRole("status")).toHaveTextContent("Processing is paused for the whole site.");

    fillName("Coffee mug");
    await addPhotos("a.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats/new-splat-1"));
    expect(uploadPhotosMock).toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/splats/new-splat-1/process", "POST", "test-token");
    expect(enqueueSnackbarMock).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, conceptPath, detailText, progressSocketUrl, read, request } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("marks a network failure as the API being down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = (await request("/health").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.down).toBe(true);
  });
  it("carries the API's detail text on a 409", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "This needs a loaded model." }), { status: 409 })));
    const err = (await request("/x").catch((e) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect(err.down).toBe(false);
    expect(err.message).toBe("This needs a loaded model.");
  });
  it("survives an error with no JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const err = (await request("/x").catch((e) => e)) as ApiError;
    expect(err.message).toBe("The API answered with status 500.");
  });
});

describe("read", () => {
  it("retries a failed read, since the API's database connection can be busy", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(read("/x")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not retry an answer the API meant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "No results yet." }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await read("/x").catch((e) => e)) as ApiError;
    expect(err.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("detailText", () => {
  it("joins validation errors", () => {
    expect(detailText([{ msg: "Field required" }, { msg: "Too big" }], 422)).toBe("Field required Too big");
  });
});

describe("paths", () => {
  it("keeps the slashes the source route expects", () => {
    expect(conceptPath("gemma-3-4b-it", "gemma-scope-2/resid_post_all/layer_14_width_16k_l0_small", 3)).toBe("/concepts/gemma-3-4b-it/gemma-scope-2/resid_post_all/layer_14_width_16k_l0_small/3");
  });
  it("builds the progress socket from the base URL", () => {
    expect(progressSocketUrl("f1")).toBe("ws://127.0.0.1:8000/forks/f1/progress");
  });
});

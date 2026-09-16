import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadImageToFal } from "../fal";
import { setAddressResolverForTest } from "@/lib/security/networkTargets.server";

/**
 * fal.ai CDN upload boundary (CRB-09 / Issue #10).
 *
 * The storage initiate response names the signed upload target. A response that
 * names a host outside fal's storage origins, or a fal host that resolves into
 * loopback/private space, must not receive the caller's image bytes.
 */

const TEST_IMAGE = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;

function initiateResponse(uploadUrl: string, fileUrl = "https://fal.media/uploaded.png") {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ upload_url: uploadUrl, file_url: fileUrl }),
  };
}

describe("uploadImageToFal destination checks", () => {
  let mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    setAddressResolverForTest(async () => ["203.0.113.10"]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAddressResolverForTest(async () => ["203.0.113.10"]);
  });

  it("refuses a Provider-supplied upload target on a foreign host", async () => {
    mockFetch.mockResolvedValueOnce(initiateResponse("https://attacker.example/put-target"));

    await expect(uploadImageToFal(TEST_IMAGE, "test-fal-key")).rejects.toThrow(
      /upload_url failed validation/
    );

    // Only the initiate call happened: the image bytes were never PUT anywhere.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("storage/upload/initiate"),
      expect.anything()
    );
  });

  it("refuses a fal upload target that resolves to loopback", async () => {
    mockFetch.mockResolvedValueOnce(initiateResponse("https://fal.media/put-target"));
    setAddressResolverForTest(async () => ["127.0.0.1"]);

    await expect(uploadImageToFal(TEST_IMAGE, "test-fal-key")).rejects.toThrow(
      /upload_url failed validation: blocked-address/
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("PUTs to an authorized fal storage origin without a credential", async () => {
    mockFetch.mockResolvedValueOnce(initiateResponse("https://fal.media/put-target")).mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const fileUrl = await uploadImageToFal(TEST_IMAGE, "test-fal-key");

    expect(fileUrl).toBe("https://fal.media/uploaded.png");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = mockFetch.mock.calls[1];
    expect(putUrl).toBe("https://fal.media/put-target");
    expect(putInit).toEqual(
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        redirect: "manual",
      })
    );
    expect(putInit.headers).not.toHaveProperty("Authorization");
  });

  it("refuses a redirect from the signed upload target", async () => {
    mockFetch
      .mockResolvedValueOnce(initiateResponse("https://fal.media/put-target"))
      .mockResolvedValueOnce({ ok: false, status: 307, headers: new Headers({ location: "https://attacker.example/sink" }) });

    await expect(uploadImageToFal(TEST_IMAGE, "test-fal-key")).rejects.toThrow(
      /unexpected redirect 307/
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

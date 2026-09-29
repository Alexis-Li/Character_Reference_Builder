import { describe, expect, it } from "vitest";
import { classifyMediaContent } from "../activeContent";
import { isDecodableRaster } from "../activeContent.server";
import { deleteImage, storeImage } from "@/lib/images/store";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";
const JPEG = "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z";
const GIF = "R0lGODlhAQABAIAAAExpcQAAACH5BAUAAAAALAAAAAABAAEAAAICRAEAOw==";
const WEBP = "UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA";
const AVIF = "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAXBtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAANGlsb2MAAAAAREAAAgABAAAAAAGUAAEAAAAAAAAAFwACAAAAAAGrAAEAAAAAAAAAFAAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAFWluZmUCAAAAAAIAAGF2MDEAAAAAr2lwcnAAAACKaXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAcAAAAAA5waXhpAAAAAAEIAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAdaXBtYQAAAAAAAAACAAEDgQIDAAIEhAIFhgAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAM21kYXQSAAoHOAAGEBDQaTIKGAAAAEAF9e9k6BIACgQYAAYVMgoYAAABABKiLh+Q";

describe("raster content verification", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/jpg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
    ["image/avif", AVIF],
  ])("accepts a real %s sample", async (mime, encoded) => {
    expect(classifyMediaContent(mime, Buffer.from(encoded, "base64"))).toBe("raster");
    expect(await isDecodableRaster(mime, Buffer.from(encoded, "base64"))).toBe(true);
  });

  it("rejects active and inert SVG documents hidden behind a PNG declaration", () => {
    const active = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const inert = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');

    expect(classifyMediaContent("image/png", active)).toBe("active-svg");
    expect(classifyMediaContent("image/png", inert)).toBe("unknown");
    expect(() => storeImage(`data:image/png;base64,${active.toString("base64")}`)).toThrow();
    expect(() => storeImage(`data:image/png;base64,${inert.toString("base64")}`)).toThrow();
  });

  it("rejects mismatched, text and truncated bytes but still serves a real PNG", () => {
    expect(classifyMediaContent("image/png", Buffer.from(JPEG, "base64"))).toBe("unknown");
    expect(classifyMediaContent("image/png", Buffer.from("<html>text</html>"))).toBe("unknown");
    expect(classifyMediaContent("image/png", Buffer.from(PNG, "base64").subarray(0, 20))).toBe("unknown");

    const id = storeImage(`data:image/png;base64,${PNG}`);
    expect(deleteImage(id)).toBe(true);
  });

  it("rejects a structurally plausible PNG whose compressed pixels cannot decode", async () => {
    const damaged = Buffer.from(PNG, "base64");
    const imageData = damaged.indexOf("IDAT", 8);
    expect(imageData).toBeGreaterThan(0);
    damaged[imageData + 4] ^= 0xff;

    expect(classifyMediaContent("image/png", damaged)).toBe("raster");
    expect(await isDecodableRaster("image/png", damaged)).toBe(false);
    expect(await isDecodableRaster("image/png", Buffer.from(PNG, "base64"))).toBe(true);
  });
});

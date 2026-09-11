/**
 * The image storage wrapper's decisions — not its delivery.
 *
 * Nothing here talks to Cloudinary. What is worth pinning is the handful of upload
 * options and URL rules that are security or cost decisions, because every one of them
 * is invisible at the call site and easy to delete without anything failing.
 *
 * THIS FILE EXISTS BECAUSE OF A REAL BUG. The upload used to pass
 * `image_metadata: false` with a comment claiming it stripped EXIF. It does not — that
 * parameter controls whether the API *returns* metadata, not whether the stored asset
 * keeps it. Nothing caught it: the suite runs against a fake uploader that never builds
 * these options at all, so the flag could have been anything. Extracting
 * `listingUploadOptions` is what makes the intent assertable.
 */

import { describe, it, expect } from "vitest";
import {
  listingUploadOptions,
  listingPhotoUrl,
  uploadListingPhoto,
  destroyListingPhoto,
  getFakeUploads,
  clearFakeUploads,
  isMediaConfigured,
  describeMediaMode,
  privateUploadOptions,
} from "../src/config/cloudinary.js";
import { env } from "../src/config/env.js";

describe("upload options — the parts that are security decisions", () => {
  const options = listingUploadOptions("listing-123");

  it("applies an INCOMING transformation, which is what actually strips EXIF", () => {
    // The whole point. An incoming transformation replaces the stored original, so
    // there is no original left holding GPS coordinates. Verified once against the real
    // provider by uploading a file with a known Exif GPS marker and re-downloading the
    // stored bytes — 246 in, 160 out, marker gone.
    expect(Array.isArray(options.transformation)).toBe(true);
    expect(options.transformation.length).toBeGreaterThan(0);
  });

  it("forces a re-encode even for a small image", () => {
    // `c_limit` alone only acts when something is too big, so a photo already under the
    // ceiling would pass through untouched — metadata and all. `quality: auto:*` is
    // what guarantees the re-encode happens regardless of size.
    const [first] = options.transformation;
    expect(first.crop).toBe("limit");
    expect(String(first.quality)).toMatch(/^auto/);
  });

  it("never carries `image_metadata`, which is the flag that looked right and was not", () => {
    // A regression guard aimed at one specific mistake: reaching for the
    // plausible-sounding parameter again.
    expect("image_metadata" in options).toBe(false);
  });

  it("uploads PUBLIC assets, not authenticated ones", () => {
    // Deliberate, and the opposite of what caution suggests. Signing a listing photo
    // would be a bug: a signed URL expires, so the CDN cannot cache it and a grid of
    // twenty listings needs twenty freshly minted URLs per page load. The content is
    // public by design.
    expect(options.type).toBe("upload");
    expect(options.resource_type).toBe("image");
  });

  it("refuses anything Cloudinary cannot decode as one of the three formats", () => {
    // Belt and braces behind our own byte-sniffing. Note SVG is absent and must stay
    // absent: it is a document, it can carry script, and it would be served from our
    // own CDN domain.
    expect(options.allowed_formats).toEqual(["jpg", "jpeg", "png", "webp"]);
    expect(options.allowed_formats).not.toContain("svg");
  });

  it("groups assets under one prefix per listing", () => {
    // So a future orphan sweep can list "our" assets, and so a shared account stays
    // separable from whatever else lives in it.
    expect(options.folder).toBe("renteasy/listings/listing-123");
  });
});

describe("private upload options — condition photos and, later, ID documents", () => {
  const options = privateUploadOptions("booking-123");

  it("uploads AUTHENTICATED assets, which is the entire point of the function", () => {
    // The one assertion here that must never be relaxed. A listing photo is
    // `type: "upload"` — world-readable forever, correct for a shop window. A
    // handover photo can show the inside of somebody's house, and an ID document
    // obviously cannot be public at all. An authenticated asset has NO public URL:
    // verified against the real provider, where the `/image/upload/<id>` form of a
    // private asset answers 404 while a signed URL answers 200.
    expect(options.type).toBe("authenticated");
    expect(options.resource_type).toBe("image");
  });

  it("strips EXIF too, and the reason is stronger than for a listing photo", () => {
    // A handover photo is taken at the moment and place an item changes hands, so its
    // GPS tag is a home address with a timestamp on it.
    const [transformation] = options.transformation;
    expect(transformation.flags).toBe("strip_profile");
    expect(transformation.quality).toBe("auto:good");
  });

  it("caps smaller than a listing photo — this is evidence, not a shop window", () => {
    const [transformation] = options.transformation;
    expect(transformation.width).toBe(1600);
    expect(transformation.crop).toBe("limit");
  });

  it("keeps private assets under their own prefix, away from listings", () => {
    // Separable at the provider, so "what is private?" is a question the account can
    // answer without inspecting the delivery type of every asset one at a time.
    expect(options.folder).toBe("renteasy/private/booking-123");
    expect(options.folder.startsWith("renteasy/listings")).toBe(false);
  });

  it("refuses SVG here as well", () => {
    expect(options.allowed_formats).toEqual(["jpg", "jpeg", "png", "webp"]);
  });
});

describe("delivery URLs", () => {
  it("builds every size from the stored id, never from a saved URL", () => {
    const url = listingPhotoUrl("renteasy/listings/abc/photo", "thumb");

    // The reason `storage_id` is stored at all: a URL would bake the provider, the
    // account, the CDN domain and the transformation into thousands of rows.
    expect(url).toContain("renteasy/listings/abc/photo");
    expect(url).toContain(env.cloudinaryCloudName || "unconfigured");
  });

  it("serves f_auto and q_auto on every variant", () => {
    // Not decoration: together they routinely halve the bytes for no visible
    // difference, which on a marketplace grid over mobile data is the difference
    // between usable and not.
    for (const variant of ["thumb", "detail", "original"]) {
      const url = listingPhotoUrl("abc", variant);
      expect(url, variant).toContain("f_auto");
      expect(url, variant).toContain("q_auto");
    }
  });

  it("crops the thumbnail to a fixed box but only ever shrinks the detail image", () => {
    // c_fill so a grid of mixed aspect ratios is not a ragged mess; c_limit so a small
    // photo is never upscaled into a blurry big one.
    expect(listingPhotoUrl("abc", "thumb")).toContain("c_fill");
    expect(listingPhotoUrl("abc", "detail")).toContain("c_limit");
  });
});

describe("the test guard", () => {
  it("never reaches the network, and says so in the banner", async () => {
    clearFakeUploads();

    // The same hazard as the mailer: env.js calls dotenv.config() on import, so real
    // credentials in `.env` are visible to the suite whether `.env.test` mentions them
    // or not. Without this branch first and unconditional, one test touching an upload
    // would write real assets into a real account that nothing ever cleans up.
    const asset = await uploadListingPhoto({ buffer: Buffer.alloc(64), listingId: "abc" });

    expect(asset.storageId).toContain("renteasy/listings/abc/");
    expect(getFakeUploads()).toHaveLength(1);
    expect(describeMediaMode()).toMatch(/fake|test/i);

    expect(await destroyListingPhoto(asset.storageId)).toBe(true);
    expect(getFakeUploads()).toHaveLength(0);
  });

  it("requires all three credentials together", () => {
    // Two of three would fail with an authentication error indistinguishable from a
    // wrong secret, so a half-filled environment must read as unconfigured.
    const original = {
      name: env.cloudinaryCloudName,
      key: env.cloudinaryApiKey,
      secret: env.cloudinaryApiSecret,
    };

    try {
      const cases = [
        ["", "", "", false],
        ["cloud", "", "", false],
        ["cloud", "key", "", false],
        ["cloud", "key", "secret", true],
      ];

      for (const [name, key, secret, expected] of cases) {
        env.cloudinaryCloudName = name;
        env.cloudinaryApiKey = key;
        env.cloudinaryApiSecret = secret;
        expect(isMediaConfigured(), `${name || "-"}/${key || "-"}/${secret || "-"}`).toBe(expected);
      }
    } finally {
      env.cloudinaryCloudName = original.name;
      env.cloudinaryApiKey = original.key;
      env.cloudinaryApiSecret = original.secret;
    }
  });

  it("never puts a credential in the startup banner", () => {
    const original = env.cloudinaryApiSecret;
    try {
      env.cloudinaryApiSecret = "super-secret-value";
      // It goes to stdout at boot, and a deployed log is not a private place.
      expect(describeMediaMode()).not.toContain("super-secret-value");
    } finally {
      env.cloudinaryApiSecret = original;
    }
  });
});

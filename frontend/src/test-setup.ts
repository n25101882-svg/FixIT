import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => { cleanup(); for (const part of document.cookie.split(";")) document.cookie = part.split("=")[0]!.trim() + "=; Max-Age=0; Path=/"; });

// jsdom has no modal top layer; actual browser keyboard/focus behavior is tested
// with Chromium E2E, while unit tests need the standard dialog open/close API.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function () { this.open = false; };
}

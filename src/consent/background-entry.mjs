// Bundle entry: exposes the shared privacy helpers to the classic background
// scripts (Firefox event page, Chromium service worker via importScripts).
import * as privacy from "./background.mjs";

globalThis.UnveilPrivacy = privacy;

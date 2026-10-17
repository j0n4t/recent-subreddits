// ==UserScript==
// @name         Recent Subreddits Sidebar
// @namespace    https://github.com/j0n4t/recent-subreddits
// @version      1.4.0
// @description  Adds a popup menu (triggered by hovering/clicking the Reddit logo) listing recently accessed subreddits with pinning support
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      reddit.com
// @run-at       document-idle
// ==/UserScript==
//
// NOTE: this file is not imported — scripts/build.mjs prepends it verbatim to
// the bundle. The metadata block has to be the first thing in the built file,
// so it cannot live in app.js.

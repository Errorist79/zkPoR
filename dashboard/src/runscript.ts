/**
 * The script of the page of one run, as text that this process serves.
 *
 * It names no host, it loads no library, and it sends nothing anywhere. It asks
 * this process for the same address the reader is already on, and it takes the
 * record of the run out of that answer. So it reaches exactly what a reload
 * reaches, and it can show nothing that the page would not show without it.
 *
 * The page works with the script disabled. The markup carries a refresh
 * directive, which reloads the whole page every few seconds, and the script
 * removes that directive when it starts. A reader who blocks the script keeps
 * the reload and loses only the place they were reading.
 *
 * The script replaces one section rather than the document, so the frame never
 * repaints and the reader never loses their scroll position.
 */

import { createHash } from "node:crypto";
import { RUN_POLL_MILLISECONDS, SECTION_IDS } from "./constants.js";

export const RUN_SCRIPT = `"use strict";
(function () {
  var id = ${JSON.stringify(SECTION_IDS.run)};
  var every = ${String(RUN_POLL_MILLISECONDS)};
  var section = document.getElementById(id);
  if (section === null) {
    return;
  }

  // The directive reloads the whole page. This script does the same work
  // without losing the place of the reader, so the directive goes. A browser
  // that ignores the removal reloads the page, which is what it did before.
  var directive = document.querySelector('meta[http-equiv="refresh"]');
  if (directive !== null) {
    directive.remove();
  }

  var timer = null;
  function stop() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function apply(text) {
    var parsed = new DOMParser().parseFromString(text, "text/html");
    var fresh = parsed.getElementById(id);
    // An answer without the section is a page about something else, which
    // happens when the process forgot this run. Stop, and leave what the
    // reader has rather than empty it.
    if (fresh === null) {
      stop();
      return;
    }
    section.replaceWith(fresh);
    section = fresh;
    if (section.getAttribute("data-stage") !== "running") {
      stop();
    }
  }

  function read() {
    window
      .fetch(window.location.href, { headers: { accept: "text/html" } })
      .then(function (answer) {
        return answer.ok ? answer.text() : null;
      })
      .then(function (text) {
        if (text !== null) {
          apply(text);
        }
      })
      // A read that fails changes nothing on the page. The next one runs, and
      // the run itself is not affected by a reader who cannot see it.
      .catch(function () {});
  }

  timer = window.setInterval(read, every);
})();
`;

/**
 * The version of the script, which is a digest of its own text.
 *
 * The address of the script carries this value, for the reason the stylesheet
 * carries one: a browser keeps the text, and a build that changes the text
 * serves it under an address that no browser has seen.
 */
export const RUN_SCRIPT_VERSION = createHash("sha256")
  .update(RUN_SCRIPT)
  .digest("hex")
  .slice(0, 16);

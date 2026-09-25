// Colour theme: follows the system setting ("auto") unless the viewer picks
// light or dark with the top bar button. Loaded as a classic script in <head>
// so the saved theme applies before the page paints (no flash).
// Ticket: P042

(function () {
  var KEY = "pixelguard-theme";
  var ORDER = ["auto", "light", "dark"];
  var root = document.documentElement;

  function read() {
    try {
      var saved = window.localStorage.getItem(KEY);
      return ORDER.indexOf(saved) >= 0 ? saved : "auto";
    } catch {
      return "auto"; // storage blocked (private mode, file://…)
    }
  }

  function apply(theme) {
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    var button = document.getElementById("theme-toggle");
    if (button) {
      button.textContent = "Theme: " + theme;
      button.setAttribute(
        "aria-label",
        "Colour theme: " + theme + ". Click to switch to " + next(theme) + "."
      );
    }
  }

  function next(theme) {
    return ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  }

  var current = read();
  apply(current);

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    apply(current); // now the button exists, give it its label
    button.addEventListener("click", function () {
      current = next(current);
      try {
        window.localStorage.setItem(KEY, current);
      } catch {
        // Not saved; still switch for this page view.
      }
      apply(current);
    });
  });
})();

import {version} from "../../package.json";

export default function AppFooter() {
  return (
    <footer className="app-footer app-footer-centered">Crowdy v{version} · Cal Hacks 13.0</footer>
  );
}

# Seeker Utilities

Seeker Utilities is a Tauri-based desktop application built with vanilla HTML, CSS and JavaScript and a Rust backend. It provides system monitoring and maintenance tools for desktop platforms.

Quick start (development):

1. Install Rust, Node (>=18 recommended), and Tauri prerequisites for your OS.
2. Install Node dependencies: `pnpm install`.
3. Run the app in dev mode: `pnpm run tauri`.

Building a release:

1. Ensure `node_modules` are installed (`pnpm ci`).
2. Build frontend assets as appropriate for your workflow (the repo currently uses the `src/` folder as frontend assets).
3. Build the Tauri app: `npx tauri build`.

Notes:

- This repository includes vendor assets in `src/` for simplicity. Consider using an explicit build step and package-managed dependencies for larger projects.

Recommended editor setup:

- VS Code with the Tauri extension and rust-analyzer for Rust support.

## License

Seeker Utilities is distributed under the terms of the GNU General Public License version 3 (GPLv3). See the bundled LICENSE file for the full text. By using or redistributing this software you agree to the terms of the GPLv3.

Copyright (C) 2026 ArcbaseHQ <support@arcbase.one>

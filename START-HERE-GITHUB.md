# Discord Message Memory v1.5.4: GitHub setup (Windows, beginner version)

**You do not need to create a new GitHub repository.** Use your existing repository:
https://github.com/Niobium-EXE/Discord-Message-Memory

This ZIP contains your actual v1.5.4 extension code **and** a workflow that will create a `.crx` file and attach it to GitHub Releases whenever you publish a new release. It will also publish an `update.xml` file on GitHub Pages.

> Important: Chrome on Windows generally does NOT permit ordinary users to install and auto-update self-hosted CRX files without an enterprise policy. This GitHub setup will still package/publish the CRX automatically, but do not count on Chrome or Opera GX accepting self-hosted updates. An unpacked ZIP is published as a fallback.

## Before changing anything: back up your messages

Open the **current** extension and export the chats you care about. Save the exported HTML/MHTML somewhere safe. **Do not remove the old extension** until you have verified the replacement and its messages.

The public `key` in the current v1.5.1 ZIP determines its extension ID. A newly generated CRX signing key will normally produce another ID. Even if the code is identical, the new ID has separate storage; the extension cannot move data between those IDs automatically. After installing a new-ID build, import the exports using the extension's built-in import settings.

## 1. Download GitHub Desktop

Go to https://desktop.github.com/ and install GitHub Desktop. Sign in to your GitHub account.

Choose **File > Clone repository**, select **Niobium-EXE/Discord-Message-Memory**, and click **Clone**. (If you already have a clone on your PC, open it rather than cloning a second copy.)

## 2. Copy these release files into your repository

Extract the ZIP from ChatGPT. Open the extracted folder. In GitHub Desktop choose **Repository > Show in Explorer** (sometimes **Open in Explorer**) to open your cloned repo.

Copy **everything INSIDE** the extracted `discord_message_memory_v1.5.4_repo_ready` folder into your repo folder. Choose **Replace files** if Windows asks. Include the `.github` folder, `tools` folder, and all extension files. **Do not put the extracted folder itself inside the repo**.

Correct folder arrangement:

```text
Discord-Message-Memory/
  manifest.json
  background.js
  content.js
  popup.html
  options.html
  ... other extension files ...
  .gitignore
  START-HERE-GITHUB.md
  .github/
    workflows/
      publish-crx.yml
  tools/
    build_crx_release.py
    create_signing_key.py
```

You should see **manifest.json directly in the repository root** (not inside another folder).

## 3. Create your ONE permanent signing key

This is the only slightly technical part. Do it **once**; never generate a new key for future releases.

From the cloned repository folder, right-click an empty area and choose **Open in Terminal**. In the resulting **PowerShell** window, paste these commands **one at a time**:

```powershell
python -m pip install cryptography
python .\tools\create_signing_key.py "$env:USERPROFILE\DiscordMessageMemorySigning\crx-signing-key.pem"
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\DiscordMessageMemorySigning\crx-signing-key.pem")) | Set-Clipboard
```

The last command silently copies the key encoded as text to your clipboard. **Don't paste it in a chat or public GitHub file.** It is a password-equivalent secret. The original PEM is saved at `C:\Users\YOUR-NAME\DiscordMessageMemorySigning\crx-signing-key.pem` **outside your GitHub repo**. Keep a secure backup of it. If the key already exists, the generator deliberately refuses to overwrite it; reuse the existing key.

If `python` is not recognized, install Python from https://www.python.org/downloads/windows/ , then reopen the terminal and try again.

## 4. Add the signing key as a GitHub Secret

On GitHub open your repository (https://github.com/Niobium-EXE/Discord-Message-Memory).

1. Click **Settings** near the top of the repository.
2. In the left menu, click **Secrets and variables**, then **Actions**.
3. Under **Repository secrets**, click **New repository secret**.
4. For the **Name**, enter `CRX_PRIVATE_KEY_B64` (exactly).
5. For the **Secret**, press **Ctrl+V** to paste the value copied by PowerShell.
6. Click **Add secret**.

Never publish that secret as a regular repository file or Release asset. If you accidentally do, you must treat the signing identity as compromised.

## 5. Upload/push the code with GitHub Desktop

Return to **GitHub Desktop**. It should list changes from the files you just copied.

At the lower left, type a **Summary**, for example `Add v1.5.4 signed release workflow`. Click **Commit to main**, then **Push origin**.

Open the repository website and verify it shows **manifest.json version 1.5.2** and a `.github/workflows/publish-crx.yml` file.

## 6. Enable GitHub Pages for update.xml

Go to your repository on GitHub:

1. Click **Settings**.
2. On the left, under **Code and automation**, click **Pages**.
3. Under **Build and deployment > Source**, choose **GitHub Actions**. No website template or second workflow is required; this package already includes the workflow.

Once the release is built and Pages has deployed, the update file should be at:

https://niobium-exe.github.io/Discord-Message-Memory/update.xml

A 404 error **before your first successful release** is normal.

## 7. Publish your first release

1. Open https://github.com/Niobium-EXE/Discord-Message-Memory .
2. In the repository sidebar, find **Releases** (or go to `/releases`).
3. Click **Draft a new release**.
4. Click **Choose a tag**, type `v1.5.4`, and choose **Create new tag on publish** targeting `main`.
5. Title it `Discord Message Memory v1.5.4`.
6. Optionally add notes such as “Adds GitHub Releases packaging and a permanent update manifest.”
7. Click **Publish release**.

**Do not manually attach the extension ZIP**: GitHub Actions will add the packed `.crx` and an unpacked fallback ZIP automatically.

Go to the **Actions** tab and open **Publish signed Discord Message Memory CRX**. Wait until it finishes successfully (green check). The workflow uploads:

- `Discord-Message-Memory-v1.5.4.crx` under your new GitHub Release.
- `Discord-Message-Memory-v1.5.4-unpacked.zip` under the same Release.
- A stable public `update.xml` on GitHub Pages.

If the action fails, click the red job and expand the failing step. Common problems are: the repository secret name was mistyped; GitHub Pages was not set to **GitHub Actions**; or the tag version doesn't match the `manifest.json` version.

## 8. Every time you release a new version

1. Edit your extension source and bump `manifest.json` to the new version (e.g. `1.5.5`). You should also bump the internal version strings in `main_hook.js`, `content.js`, and `options.js` as appropriate.
2. Commit and **Push origin** with GitHub Desktop.
3. On GitHub, create a **new Release** with tag matching the next version, such as `v1.5.5`.
4. The exact same signing key is loaded from the GitHub secret; the action builds a new `.crx`, adds it to that release, and updates the public `update.xml`.

**Never regenerate or change your signing key.** A changed key creates a different extension ID. A new release must have a **higher version** than the version currently installed in the browser.

## What about the Check for updates toggle?

The **Check for updates** toggle requests update checks, but does not automatically call `runtime.reload()` for you. The **Apply packed updates** button lets you explicitly apply a browser-staged update or get the GitHub Release if the browser cannot stage the CRX. The browser may still manage updates itself during its normal lifecycle.

## What if I'm using Chrome or Opera GX on Windows?

The CRX + XML build pipeline still works, but installing and auto-updating self-hosted CRX files may not work in a normal unmanaged Windows installation. For Chrome, the official supported alternatives are managed policies or publishing in the Chrome Web Store. Opera GX behavior may differ, and this setup has not been validated there. For a normal unpacked extension you can use the unpacked ZIP attached to each Release, extract it and reload the existing extension folder manually.

Remember: a new extension ID has **different local storage**. Back up your saved chats first, and keep the old installation until imports and exports are confirmed.


## v1.5.4 — Manually applying a pending packed update

The **Check for updates** switch is off by default. Turning it on asks a compatible browser to check for a newer packed extension and checks the public GitHub Pages release manifest periodically (every 6 hours). If the browser reports a pending update, the **Apply packed updates → Apply update** button becomes available in the toolbar dropdown and the General settings page. Clicking it explicitly reloads the installed extension to apply the pending CRX.

Turning this switch off stops extension-initiated checks and Message Memory never reloads itself automatically upon `runtime.onUpdateAvailable`. **This is not a way to disable the browser's own update service:** Chromium can still install an extension update during its normal lifecycle, including a browser restart. The button is disabled in the absence of a pending browser-managed update and will not install a CRX over an unpacked extension.

**Storage safety:** this release retains the `key` and `update_url` from v1.5.2. A normal in-place update to the **same packed extension ID** uses the same IndexedDB/chat storage. Don't remove the old extension or switch to a different extension ID without exporting/importing saved chats first.

On browsers that do not stage GitHub CRX updates themselves, the update button becomes **Get update**, opening the appropriate GitHub Release for manual installation. That fallback never claims to install an extension.


## v1.5.4 — Export all saved chats as a ZIP

Open **Message Memory → Settings → Saved chats → Export all chats**. Select HTML (default) or MHTML and any desired advanced export options, then click **Export all chats to ZIP**. Message Memory exports **all saved chats**, ignoring the chat-list search field, and places one standalone transcript file per chat inside the downloaded ZIP. Filenames include the channel ID so repeated chat names remain distinct.

A progress bar shows which chat is currently being prepared. The ZIP is created locally in the browser and the extension's stored messages are not changed. Large backups containing media can take a while; the built-in ZIP writer warns and stops if a ZIP would exceed 4 GB. If it stops, export large chats individually or turn off embedded files, media and videos. To import a backup, extract the ZIP and select the resulting HTML/MHTML transcript files with the existing Message Memory importer.

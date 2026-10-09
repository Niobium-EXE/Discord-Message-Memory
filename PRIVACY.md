# Privacy Policy — Discord Message Memory

**Effective date:** October 9, 2026  
**Developer:** Niobium-EXE  
**Extension:** Discord Message Memory

Discord Message Memory is a browser extension that helps users preserve and review Discord conversation history, including edits and deletions, and export saved chats. This policy explains what information the extension processes, where it is stored, and when it may communicate with other services.

## 1. Information the extension processes

When message remembering is enabled and Discord is open in a supported browser tab, the extension can process and save information that Discord makes available to the browser, including:

- Message text, including messages in direct messages, group messages, servers, and threads; message edits, previous versions, and deletion status.
- Names, display names, usernames, user IDs, avatars, channel and server identifiers, message IDs, timestamps, and related message metadata.
- Message attachments, images, videos, audio, embeds, links, and other media or metadata. Attachment files may be cached when available.
- User-selected preferences, such as message remembering and display settings, optional custom CSS, notification sound settings, auto-scroll speed, and update-check preferences.
- Files the user explicitly chooses to import into the extension.

The information saved may include personal communications and personal information about people participating in a conversation. The extension is not limited to messages written by the person using it.

## 2. How information is used

The extension processes this information to provide its advertised features: remembering messages, detecting edits and deletions, displaying saved history inside Discord, caching available media, searching and managing locally saved chats, and creating user-requested HTML, MHTML, and ZIP exports. Preferences are used to configure these features.

The extension does not use saved conversations for advertising, profiling, or sale of data.

## 3. Local storage and browser sync

**Saved chats and cached attachments are stored on the user's device**, primarily using the browser's IndexedDB storage. Extension settings are stored using browser extension storage.

The extension does not operate a developer-controlled server that receives or stores users' saved Discord conversations. It does not automatically upload chat histories or cached attachments to the developer.

The **Check for updates** on/off preference may additionally be saved using the browser's optional sync storage, if supported and enabled. **Chat histories and cached attachments are not synced by that feature.** Browser vendors may process synced preference data according to their own privacy policies.

Local storage is subject to the browser's profile settings, storage behavior, and device security. The extension does not separately encrypt saved chat records at rest. Anyone with access to the user's unlocked browser profile or exported files may be able to access this information.

## 4. Network requests and third parties

The extension interacts with Discord's websites (including discord.com, ptb.discord.com, and canary.discord.com) to provide its message-history features. It may request message attachments, avatar images, or other media from Discord-controlled services such as **cdn.discordapp.com** and **media.discordapp.net**. These requests are made so the content can be displayed or cached; Discord and its media services may receive the usual network request information, such as IP address and requested resource URL.

If the user enables update checking and the installed edition supports it, the extension may contact the project's **GitHub/GitHub Pages** update endpoint to look for a newer version. Such checks do **not** include stored chat messages or attachments. GitHub may receive ordinary request information associated with accessing its service.

Exports are created on the user's device. The extension does not automatically send exported transcripts to the developer or third parties. **If the user shares an exported file, its contents are disclosed to whoever receives it.** Exported files may also contain links to external resources, which can make network requests when the files are opened.

Discord, GitHub, browser vendors, and any other sites accessed through links have their own privacy practices. Discord Message Memory is an independent project and is not affiliated with Discord.

## 5. Retention and deletion

Saved data remains in the browser's extension storage until the user deletes it, the browser removes it, or storage is otherwise lost or cleared. There is no automatic time-based deletion schedule for locally saved chat history.

Users can delete individual saved chats or all saved message data and cached attachments through the extension's settings. Disabling message remembering stops new capture but does not automatically delete records already saved. Files previously exported to the device must be deleted separately by the user.

Users can also manage or remove extension storage through their browser. Uninstalling or reinstalling may affect stored data or create a different extension storage location; backing up important chats before doing so is recommended.

## 6. Children's privacy

The extension is not specifically directed at children. It processes only the Discord data available through the user's browser, and its use is subject to Discord's own age requirements and applicable law.

## 7. Chrome Web Store Limited Use disclosure

The developer's use of information received through the extension complies with the **Chrome Web Store User Data Policy, including the Limited Use requirements**. Data handled by the extension is used only to provide or improve the extension's disclosed message-history, local-storage, media-caching, and export functions; it is not sold, used for personalized advertising, or transferred to data brokers. The developer does not have routine access to users' locally stored conversations.

## 8. Changes to this policy

This policy may be updated if the extension's features or data practices change. Updates will be published at the policy's public URL with a revised effective date. Material changes to data handling should be disclosed appropriately to users.

## 9. Contact

For questions about this privacy policy or the extension, contact the developer through the project's [GitHub Issues page](https://github.com/Niobium-EXE/Discord-Message-Memory/issues). GitHub Issues are public; do not post private Discord messages, personal information, or account credentials in an issue.

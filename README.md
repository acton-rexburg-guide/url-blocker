# Workspace URL Filter

A website filter for Chromebooks and managed Chrome browsers, run from Google Workspace.

| You asked for | How it works here |
| --- | --- |
| Allowlist **or** blocklist | Pick a **mode** per OU or group. Allowlist blocks everything except what you allow. Blocklist allows everything except what you block. |
| Timers by day and time | **Schedules** add sites or switch the mode on chosen days and times, such as "School hours, Mon–Fri 08:00–15:00, allowlist". |
| Links from a certain site always approved | **Approved sources**: any link opened from, say, `classroom.google.com` is allowed, whatever its domain. |
| Tied to Workspace OUs and groups | Settings are stored as Chrome policy on an **organizational unit** or **group**. Workspace handles inheritance and who gets what. |
| Don't break the Chromebook when blocking Google | The filter only acts on web pages opened in tabs. It never touches ChromeOS system traffic, so there's no list of system services to maintain. A built-in setting keeps Google sign-in pages open even if `google.com` is blocked. See [Essential services](#essential-services-and-blocking-google). |

There are two parts:

- **`extension/`**: a Chrome extension (Manifest V3) that you force-install on users. It reads its settings from Workspace and blocks pages using Chrome's built-in `declarativeNetRequest` engine.
- **`dashboard/`**: an admin dashboard. It's a Google Apps Script web app that lists your OUs and groups and saves settings to them through the Chrome Policy API.

```
 Admin ──► Dashboard (Apps Script) ──► Chrome Policy API ──► OU / group policy
                                                               │
                         Chromebook ◄── force-installed extension reads it
```

---

## Installation

You'll do this once. Budget about an hour.

### Step 1: Host the extension on GitHub Pages (no Web Store)

The extension is self-hosted from this repo. Every push to `main` that changes `extension/` runs the **Publish extension** GitHub Action (`.github/workflows/publish-extension.yml`). It signs the extension and publishes it to GitHub Pages:

- `https://acton-rexburg-guide.github.io/url-blocker/updates.xml`: the update manifest Chromebooks check
- `https://acton-rexburg-guide.github.io/url-blocker/url-filter.crx`: the signed extension
- `https://acton-rexburg-guide.github.io/url-blocker/`: a page showing the current version and extension ID

The version number goes up automatically on every publish, so Chromebooks pick up changes on their next update check (usually within a few hours; `chrome://extensions` → **Update** forces it).

One-time setup:

1. **Add the signing key as a secret.** Self-hosted extensions are signed with a private key, and the key determines the extension ID.
   - In the repo, open **Settings → Secrets and variables → Actions → New repository secret**.
   - Name it `EXTENSION_PRIVATE_KEY` and paste the whole key file, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.
   - **Keep a backup of the key somewhere private.** If it's lost, the extension gets a new ID and has to be re-added in the Admin console.
   - To make a new key instead, run `npm run keygen`. It writes `extension-key.pem` and prints the ID. `*.pem` files are git-ignored. Never commit the key: the repo is public.
2. **Turn on Pages.** Go to **Settings → Pages**, set **Source** to **GitHub Actions**.
3. **Publish.** Go to **Actions → Publish extension → Run workflow** (or push a change to `extension/`). When it's green, open the Pages URL above to confirm the version and **extension ID**.

The extension ID for the key generated with this setup is **`chnnefiligaknogfjhfhbmiahinkldmf`**.

### Step 1b: Force-install it from the Admin console

1. Open **Devices → Chrome → Apps & extensions → Users & browsers** and select the OU to cover. Use the top-level OU to cover everyone, since sub-OUs inherit.
2. Click the yellow **+** → **Add Chrome app or extension by ID**.
3. Paste the extension ID, choose **From a custom URL**, enter `https://acton-rexburg-guide.github.io/url-blocker/updates.xml`, and click **Save**.
4. Set its installation policy to **Force install** (and **Pin to browser toolbar** if you want students to see its status icon).

To limit it to certain groups instead, do the same on the **Groups** tab for each group.

> For a quick test without any of this, see [Testing locally](#testing-locally).

### Step 2: Install the admin dashboard

You need a Workspace **super admin**, or an admin with Chrome management and read access to OUs and groups.

1. **Create a Google Cloud project** (or use an existing one) at <https://console.cloud.google.com>.
   - Under **APIs & Services → Library**, enable **Chrome Policy API** and **Admin SDK API**.
   - Under **APIs & Services → OAuth consent screen**, choose **Internal** and fill in the app name and support email.
   - Note the **project number** shown on the project's Dashboard page.
2. **Create the Apps Script project** at <https://script.google.com>, then click **New project** and name it "URL Filter Admin".
   - Click **Project Settings** (gear icon) and check **Show "appsscript.json" manifest file in editor**.
   - Under **Google Cloud Platform (GCP) Project**, click **Change project** and enter the project number from step 1.
   - Back in **Editor**, replace the contents of `Code.gs` and `appsscript.json` with the files from `dashboard/`.
   - Add an HTML file named `Index` (**+ → HTML**) and paste in `dashboard/Index.html`.
   - Edit `"timeZone"` in `appsscript.json` if you like. It only affects Apps Script logs.

   *Command-line alternative:* `npm i -g @google/clasp`, then `clasp login`, then run `clasp create --type webapp --title "URL Filter Admin" --rootDir dashboard` and `clasp push`. You still need to link the GCP project as described above.
3. **Deploy:** click **Deploy → New deployment**, pick type **Web app**, set *Execute as* to **User accessing the web app** and *Who has access* to **Anyone within [your domain]**, then click **Deploy**.
4. Open the **web app URL** and approve the permission prompt. Bookmark the URL: **this is your admin dashboard.**

Because the dashboard runs as the person using it, a non-admin who opens it can't change anything. Google rejects their requests.

**If the dashboard stays on "Loading…"** or Save does nothing, read the status bar under the title, then check:
- **More than one Google account signed in.** Apps Script web apps often fail silently then. Open the dashboard in an incognito window, or a Chrome profile signed in only to your Workspace admin account.
- **Admin SDK API and Chrome Policy API** are enabled in the linked Cloud project (Step 2.1), and the Apps Script project is linked to it.
- **After pasting new code, redeploy.** The web app URL serves the deployed version, not the editor's. Use **Deploy → Manage deployments → Edit → Version: New version → Deploy**.
- In the Apps Script editor, **Executions** (left sidebar) shows the actual error for each failed call.

### Step 3: Lock down bypasses (Admin console)

Under **Devices → Chrome → Settings → Users & browsers**, for the OUs you filter, set:

| Setting | Value | Why |
| --- | --- | --- |
| Incognito mode | Disallow incognito mode | Extensions don't run in incognito by default |
| Browser guest mode / Guest mode | Block | Guest sessions don't get your extension |
| Developer tools | Never allow use of built-in developer tools | Stops users from tampering with the extension |
| Android apps / Linux | Off, unless you need them | Android browsers and Linux apps don't go through Chrome's extensions |

### Step 4: Set up the first OU

1. Open the dashboard, paste the **extension ID** in **Setup**, and click **Save**.
2. Pick a **pilot OU** (or test group) where the extension is force-installed (Step 1b), write your rules, and click **Save**.
3. On a pilot Chromebook, open `chrome://policy`, click **Reload policies**, and check that "Workspace URL Filter" appears in `chrome://extensions`. Click the extension's toolbar icon to see which mode and schedules are active.
4. Once it works, roll out to more OUs. If you're replacing your old Admin console URL blocking, clear those lists after migrating them (see below) so the two don't fight.

---

## Using the dashboard

### 1. Setup

You save the extension ID once. It's stored in the script's properties.

### 2. Who these settings apply to

- Choose **Organizational unit** or **Group** and pick one from the list. Type in the filter box to search.
- **Load current settings** shows what currently applies to that OU or group, and says whether it was set there or **inherited** from a parent OU.
- **Import Admin console URL lists** copies the allowlist and blocklist you already have under Admin console URL blocking into the form, which helps with migration. If your old blocklist contains `*`, the mode switches to Allowlist.

How Workspace decides which settings a user gets:
- A sub-OU uses its parent's settings until you save settings on the sub-OU itself.
- **Group settings override OU settings.** If a user is in several groups that all have settings, the group ranked highest wins. Set that order in the Admin console under **Devices → Chrome → Apps & extensions → Users & browsers → Groups**.

### 3. Rules

- **Mode**: allowlist or blocklist.
- **Allowed / Blocked sites**: one per line.
  - `example.com` matches the domain and all its subdomains.
  - `youtube.com/shorts` matches only that part of the site.
  - `https://`, `*.` and query strings are stripped automatically, so you can paste lists from the Admin console.
  - **Allowed beats blocked.** In blocklist mode, the allowed list holds exceptions. For example, block `youtube.com` and allow `youtube.com/edu`.
- **Approved sources**: any link clicked or opened from these sites is allowed, even if its domain would be blocked. That covers the same tab, a new tab, and redirects.
  - *Keep the whole linked site open in that tab* (default): after a student clicks a Classroom link to `khanacademy.org`, they can keep browsing Khan Academy in that tab. Leaving that site, or opening it fresh in another tab, follows the normal rules.
  - *Allow only the linked page itself*: just the page that was opened.
  - Approved source sites are always allowed themselves.
- **Never block Google sign-in and account pages**: leave this on. See below.
- **Also filter embedded frames**: off by default. Turn it on to also block blocked sites shown *inside* other pages, like an embedded YouTube player. It's stricter, but it can break widgets on allowed sites.
- **Time zone**: set your school's time zone, such as `America/Denver`, so schedules don't follow a device whose clock is set wrong. Leave it blank to use each device's clock.
- **Blocked-page message**: shown to the user, along with when access next changes.

### 4. Schedules

Each schedule has days, a start and end time (24-hour, like `08:00`), an optional mode switch, and extra sites to allow or block while it's on.

Example setup for a student OU:

| Schedule | Days | Time | Mode while on | Also allow |
| --- | --- | --- | --- | --- |
| *(base rules)* | – | – | Blocklist, block `games.com` | – |
| School hours | Mon–Fri | 08:00–15:00 | Allowlist | `classroom.google.com`, `khanacademy.org` |
| Lunch | Mon–Fri | 11:45–12:30 | – | `youtube.com` |
| Overnight | Sun–Thu | 22:00–06:00 | Allowlist | – |

How schedules combine:
- While schedules are on, their sites are added to the base lists.
- If several schedules switch the mode at the same time, the one **lowest** in the list wins.
- An end time earlier than the start runs past midnight. Its days are the days it *starts* on.
- Same start and end means all day.
- Devices check every minute, so changes happen on time without a network round-trip.

### 5. Save

- **Save** writes the settings to the selected OU or group. Devices pick up the change within minutes. `chrome://policy` → **Reload policies** applies it at once.
- **Also set the extension to force-install here** is off by default. The Admin console setup in Step 1b already covers OUs that inherit it. Tick it only for a group, or an OU that overrides the install setting, and only after the extension has been added there by custom URL.
- **Show JSON** shows exactly what gets stored.
- **Remove settings** deletes this OU's or group's own settings so it inherits again.

**If saving to a group fails**, the extension usually hasn't been added to that group yet. Add it on the **Groups** tab as in Step 1b, then save again. As a fallback, you can paste the **Show JSON** output into the extension's **Policy for extensions** box in the Admin console.

---

## Essential services and blocking Google

Your concern is the Admin console's built-in option to avoid blocking URLs that ChromeOS needs. Its list is maintained by Google. This filter handles the problem differently, so **there is no list for you to keep updated**:

1. **It only filters pages opened in tabs and frames.** Chrome's extension engine never sees ChromeOS system traffic: sign-in to the device, policy sync, OS and Chrome updates, time sync, Play Store, and `chrome://` pages. So blocking `google.com` or switching to an allowlist can't break the Chromebook itself. Background requests a page makes, like scripts, images, and fonts, also aren't filtered. Only the page you navigate to is.
2. **Sign-in pages stay open.** With *Never block Google sign-in and account pages* on, a short built-in list always wins over your block rules, so users can still sign in to Google and to "Sign in with Google" sites. It covers `accounts.google.com`, `accounts.youtube.com`, `gds.google.com`, `apis.google.com`, `content.googleapis.com`, `ogs.google.com`, and reCAPTCHA. These are long-standing account endpoints, not Chrome-version-specific. The list lives in `extension/lib/policy.js` (`ESSENTIAL_ENTRIES`).
3. **The Admin console's built-in protection still applies.** If you keep any URLs in the Admin console's own URL blocking, for example a few hard blocks, its sensitive-URL option keeps protecting those as before. This extension doesn't replace or change that setting.

Blocking `google.com` here blocks the Google *websites* (Search, Drive, Docs, and so on) as pages. If you want Docs but not Search, allow `docs.google.com` and `drive.google.com` and block `google.com`.

---

## Testing locally

1. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
2. Click the extension's toolbar icon. Unpacked installs show a **Test config** box. Paste settings JSON (the same shape as the dashboard's **Show JSON**) and click **Apply**.
3. Run the unit tests with `npm test` (Node 20+).

An unmanaged unpacked install filters nothing until you give it a test config. On managed devices, the Admin console settings always win.

## Settings reference

Stored as the extension's managed configuration (`extension/schema.json`):

```json
{
  "mode": "allowlist",
  "allow": ["classroom.google.com", "khanacademy.org"],
  "block": ["youtube.com/shorts"],
  "approvedSources": ["classroom.google.com"],
  "approvedSourceScope": "site",
  "protectEssentials": true,
  "blockEmbeds": false,
  "timezone": "America/Denver",
  "blockMessage": "Ask your teacher if you need this site.",
  "schedules": [
    { "name": "Lunch", "days": ["mon", "tue", "wed", "thu", "fri"], "start": "11:45", "end": "12:30",
      "mode": "", "allow": ["youtube.com"], "block": [] }
  ]
}
```

## Limits

- Filtering applies in Chrome on managed accounts. Android apps, Linux apps, and other browsers aren't covered (see Step 3).
- URLs with an unusual port (`site.com:8080`) aren't matched by path-specific entries. Domain entries still match them.
- Approved-source matching uses the site the link was clicked on, so a link copied and pasted into a new tab follows the normal rules.

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

> **✅ It worked if:**
> - **Actions → Publish extension** shows a green check for the latest run.
> - **Settings → Pages** says "Your site is live".
> - The Pages URL shows a version number and the extension ID above. A different ID means the secret holds a different key.

### Step 1b: Force-install it from the Admin console

1. Open **Devices → Chrome → Apps & extensions → Users & browsers** and select the OU to cover. Use the top-level OU to cover everyone, since sub-OUs inherit.
2. Click the yellow **+** → **Add Chrome app or extension by ID**.
3. Paste the extension ID, choose **From a custom URL**, enter `https://acton-rexburg-guide.github.io/url-blocker/updates.xml`, and click **Save**.
4. Set its installation policy to **Force install** (and **Pin to browser toolbar** if you want students to see its status icon).

To limit it to certain groups instead, do the same on the **Groups** tab for each group.

> **Why the Admin console shows only an ID, with no name or icon:** the Admin console gets an extension's name and icon from the Chrome Web Store. A self-hosted extension isn't in the Web Store, so its row shows the ID `chnnefiligaknogfjhfhbmiahinkldmf` and a blank icon. That's cosmetic; it installs and works the same. The name and icon do show in `chrome://extensions` and the toolbar on devices. To get them in the Admin console too, the extension would have to be published to the Web Store as a **Private** item visible only to your domain, which means a Web Store developer account and Google review for each update.

> **✅ It worked if,** on a Chromebook signed in as a user in that OU:
> - `chrome://policy` → **Reload policies**, then `chrome://extensions` lists **Workspace URL Filter** with ID `chnnefiligaknogfjhfhbmiahinkldmf` and "Installed by your administrator".
> - Clicking its toolbar icon opens a popup with a version number. "Settings from: Not configured" is expected until Step 4.

> For a quick test without any of this, see [Testing locally](#testing-locally).

### Step 2: Install the admin dashboard

You need a Workspace **super admin**, or an admin with Chrome management and read access to OUs and groups.

1. **Create a Google Cloud project** (or use an existing one) at <https://console.cloud.google.com>.
   - Under **APIs & Services → Library**, enable **Chrome Policy API** and **Admin SDK API**.
   - Note the **project number** shown on the project's Dashboard page.
   - Set up the **OAuth consent screen** (next step). Apps Script refuses to link a Cloud project that doesn't have one.

   **Set up the OAuth consent screen.** This is the "URL Filter Admin wants to access your Google Account" prompt admins see the first time they open the dashboard.
   1. In the same Cloud project, open **APIs & Services → OAuth consent screen**. Newer consoles call it **Google Auth Platform**; if you see **Get started**, click it.
   2. **App information:** App name `URL Filter Admin`, and a **User support email** (your address or an admin group). Click **Next**.
   3. **Audience:** choose **Internal**. Only accounts in your Workspace domain can use it, and Google doesn't need to verify the app. (If Internal is greyed out, the project isn't in your Workspace organization: create it while signed in as a Workspace account, or move it under your organization.)
   4. **Contact information:** an email for Google to send notices about the project. Click **Next**, agree to the user data policy, then **Continue → Create**.
   5. You don't need to add scopes or create an OAuth client by hand. Apps Script adds the scopes listed in `dashboard/appsscript.json` when you link the project.

   > **✅ It worked if** **OAuth consent screen** (or **Google Auth Platform → Audience**) shows *User type: Internal*.
2. **Create the Apps Script project** at <https://script.google.com>, then click **New project** and name it "URL Filter Admin".
   - Click **Project Settings** (gear icon) and check **Show "appsscript.json" manifest file in editor**.
   - Under **Google Cloud Platform (GCP) Project**, click **Change project** and enter the project number from step 1.
   - Back in **Editor**, replace the contents of `Code.gs` and `appsscript.json` with the files from `dashboard/`.
   - Add an HTML file named `Index` (**+ → HTML**) and paste in `dashboard/Index.html`.
   - Edit `"timeZone"` in `appsscript.json` if you like. It only affects Apps Script logs.

   *Command-line alternative:* `npm i -g @google/clasp@2.4.2`, then `clasp login`, then run `clasp create --type webapp --title "URL Filter Admin" --rootDir dashboard` and `clasp push`. You still need to link the GCP project as described above. To have GitHub do this on every change, see [Automatic dashboard deploys](#automatic-dashboard-deploys-optional) after Step 3 below.
3. **Deploy:** click **Deploy → New deployment**, pick type **Web app**, set *Execute as* to **User accessing the web app** and *Who has access* to **Anyone within [your domain]**, then click **Deploy**.
4. Open the **web app URL** and approve the permission prompt. Bookmark the URL: **this is your admin dashboard.**

Because the dashboard runs as the person using it, a non-admin who opens it can't change anything. Google rejects their requests. The Apps Script and Cloud projects can belong to any account in your domain; each admin opens the dashboard as themselves. Share the Apps Script project (**Share** button) with admins who should be able to run `diagnose` or update the code.

> **✅ It worked if:**
> - As an admin, in the Apps Script editor, pick `diagnose` next to **Run** and click **Run**. Every line in the Execution log starts with `OK`.
> - The `/exec` URL shows your email at the top right and opens on **Setup** with "Start by saving the extension ID".

#### Automatic dashboard deploys (optional)

Once Step 2 works by hand, the **Deploy dashboard** GitHub Action (`.github/workflows/deploy-dashboard.yml`) can do the paste-and-redeploy for you. On every push to `main` that changes `dashboard/`, it runs the tests, then `clasp push` and `clasp deploy` to the web app deployment you already have, so the `/exec` URL stays the same. Until the secrets below exist it skips with a notice.

One-time setup, on your own computer:

1. Turn on the Apps Script API for the account that will deploy: <https://script.google.com/home/usersettings> → **Google Apps Script API** → On. Use an account that can edit the Apps Script project.
2. Install clasp and log in:
   ```bash
   npm i -g @google/clasp@2.4.2
   ```
   ```bash
   clasp login
   ```
   This writes `~/.clasprc.json` (on Windows, `%USERPROFILE%\.clasprc.json`). It holds a login token for your account, so treat it like a password.
3. In the repo, open **Settings → Secrets and variables → Actions** and add three repository secrets:

   | Secret | Value | Where to find it |
   | --- | --- | --- |
   | `CLASPRC_JSON` | The whole contents of `~/.clasprc.json` | From step 2 |
   | `SCRIPT_ID` | The Apps Script project's ID | Apps Script editor → **Project Settings → IDs → Script ID** |
   | `DEPLOYMENT_ID` | The web app deployment's ID (starts with `AKfy`) | **Deploy → Manage deployments**, select the web app, copy **Deployment ID** |

4. Go to **Actions → Deploy dashboard → Run workflow**.

> **✅ It worked if:**
> - The run is green, and the **Push and deploy with clasp** step lists the pushed files and your deployment ID.
> - In the Apps Script editor, **Deploy → Manage deployments** shows a new version with the description `GitHub <commit>`.
> - The `/exec` URL still loads and shows any change you made.

If a later run fails with `invalid_grant` or `unauthorized`, the token expired or was revoked (a password change, or a Workspace session-length policy can do this). Run `clasp login` again and replace `CLASPRC_JSON`.

**If the dashboard stays on "Loading…"** or Save does nothing, read the message at the bottom of the page, then check:
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

> **✅ It worked if,** on a pilot Chromebook after **Reload policies** in `chrome://policy`: opening an incognito window (Ctrl+Shift+N) does nothing or shows it's disabled, and `chrome://policy` lists `IncognitoModeAvailability` and `DeveloperToolsAvailability` with the values you set.

### Step 4: Set up the first OU

1. Open the dashboard. It opens on **Setup** the first time: paste the **extension ID** and click **Save**.
2. Click **Settings**, pick a **pilot OU** (or test group) on the left where the extension is force-installed (Step 1b), write your rules, and click **Save** in the bar at the bottom.
3. On a pilot Chromebook, open `chrome://policy`, click **Reload policies**, and check that "Workspace URL Filter" appears in `chrome://extensions`. Click the extension's toolbar icon to see which mode and schedules are active.
   **✅ It worked if:**
   - Saving the ID says "Extension ID saved.", and after a page reload the ID is still in the box.
   - Saving rules says "Saved to …".
   - **Check a user** with a pilot user's email shows no red ✖.
   - On the pilot Chromebook, the popup says "Settings from: Google Admin console" with the mode you chose, and a site you blocked shows the "blocked" page.
4. Once it works, roll out to more OUs. If you're replacing your old Admin console URL blocking, clear those lists after migrating them (see below) so the two don't fight.

---

## Using the dashboard

It's laid out like the Admin console:

- **Top bar:** **Settings** (the default), **Check a user** (see [When a change doesn't reach a device](#when-a-change-doesnt-reach-a-device)), and **Setup**, where you save the extension ID once. It's stored in the script's properties.
- **Left panel:** your **Organizational units** as a tree, and a **Groups** tab. Type in the search box to filter.
- **Right:** the settings for whatever you click on the left. They load as soon as you click; there's no load button.

### 1. Who these settings apply to

Click an OU or group on the left. The chips next to its name say:
- **Locally applied**: settings are saved on this OU or group.
- **Inherited**: it's using a parent OU's settings. Saving creates its own copy.
- **Not configured**: nothing applies yet.
- **Force-installed** / **Not force-installed**: whether the extension is installed for it (Step 1b).

**Import Admin console URL lists** (top of **Rules**) copies the allowlist and blocklist you already have under Admin console URL blocking into the form, which helps with migration. If your old blocklist contains `*`, the mode switches to Allowlist.

How Workspace decides which settings a user gets:
- A sub-OU uses its parent's settings until you save settings on the sub-OU itself.
- **Group settings override OU settings.** If a user is in several groups that all have settings, the group ranked highest wins. Set that order in the Admin console under **Devices → Chrome → Apps & extensions → Users & browsers → Groups**.

### 2. Rules

- **Mode**: allowlist or blocklist.
- **Allowed / Blocked sites**: one per line.
  - `example.com` matches the domain and all its subdomains.
  - `youtube.com/shorts` matches only that part of the site.
  - `https://`, `*.` and query strings are stripped automatically, so you can paste lists from the Admin console.
  - **Allowed beats blocked.** In blocklist mode, the allowed list holds exceptions. For example, block `youtube.com` and allow `youtube.com/edu`.
- **Approved sources**: any link clicked or opened from these sites is allowed, even if its domain would be blocked. That covers the same tab, a new tab, and redirects.
  - *Keep the whole linked site open in that tab* (default): after a student clicks a Classroom link to `khanacademy.org`, they can keep browsing Khan Academy in that tab. Leaving that site, or opening it fresh in another tab, follows the normal rules.
  - *Allow only the linked page itself*: just the page that was opened. Moving to another page on that site is blocked, including on sites like YouTube that switch pages without a full reload (clicking another video).
    - **8-second settling period.** Many sites change their own URL while a page loads (YouTube opens `watch?v=ID&feature=youtu.be`, then rewrites it). So for the first 8 seconds after the link opens, any change on the same site is accepted and becomes the allowed page. After that, only the page itself is allowed; small URL changes like adding `&t=30s` are still fine.
    - Trade-off: clicking to another page on that site within those first 8 seconds also gets through.
    - To change the length, edit `LINK_SETTLE_MS` in `extension/lib/policy.js`.
  - Approved source sites are always allowed themselves.
- **Never block Google sign-in and account pages**: leave this on. See below.
- **Also filter embedded frames**: off by default. Turn it on to also block blocked sites shown *inside* other pages, like an embedded YouTube player. It's stricter, but it can break widgets on allowed sites.
- **Time zone**: set your school's time zone, such as `America/Denver`, so schedules don't follow a device whose clock is set wrong. Leave it blank to use each device's clock.
- **Blocked-page message**: shown to the user, along with when access next changes.
- **Temporary allow**: see [Temporary allow password](#temporary-allow-password) below. It's set once for the whole organization under **Setup**, not per OU or group.

### Temporary allow password

**Setup → Temporary allow → Admin password** is one password for the whole organization. Once it's set, the blocked page shows a **Temporarily allow** button for everyone. Whoever knows the password (a teacher at the student's desk, say) picks:
- *The whole site*: every page on that site and its subdomains (`www.youtube.com` → `youtube.com`), including when embedded frames are filtered.
- *Only this page*: just that page, judged the same way as *Allow only the linked page itself* above. Small URL changes like `&t=30s` are fine; another video, or another page on the site, is blocked, including in-page switches on sites like YouTube.
- *How many minutes*: 1 to 1440. When time runs out, an open tab on that site goes back to the blocked page within a minute.

The allow applies only to the person signed in to that browser. It doesn't reach other users or devices. After 5 wrong passwords the form locks for a minute. The extension's popup lists what's temporarily allowed and until when.

Setting, changing, or removing the password takes effect right away (no Save needed). The dashboard writes it into every OU and group that has its own settings, and into any you save later, because Chrome uses the most specific OU or group's settings as a whole and doesn't merge them.

The dashboard hashes the password in your browser (PBKDF2-SHA256) and saves only the hash. That hash is still visible to users at `chrome://policy`, so use a long password that isn't used for anything else, and change it here if it gets out. **Remove password** turns the button off. Allows already granted stay until they run out.

### 3. Schedules

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

### 4. Save

- When you change anything, a bar appears at the bottom with **Save** and **Cancel**. **Save** writes the settings to the selected OU or group. Devices pick up the change within minutes. `chrome://policy` → **Reload policies** applies it at once. Clicking another OU or group with unsaved changes asks first.
- **Installation → Also set the extension to force-install here** is off by default. The Admin console setup in Step 1b already covers OUs that inherit it. Tick it only for a group, or an OU that overrides the install setting, and only after the extension has been added there by custom URL.
- **Advanced → Show JSON** shows the settings as plain JSON (the format the extension's **Test config** box takes). The dashboard stores them with each setting wrapped as `{"mode": {"Value": "allowlist"}}`, the format the Admin console requires.
- **Advanced → Inherit** (for an OU) or **Delete** (for a group) removes its own settings so it inherits again. It only appears when settings are saved there.

**If saving to a group fails**, the extension usually hasn't been added to that group yet. Add it on the **Groups** tab as in Step 1b, then save again. As a fallback, you can paste the **Show JSON** output into the extension's **Policy for extensions** box in the Admin console, after wrapping each setting as `{"mode": {"Value": "allowlist"}, "block": {"Value": ["games.com"]}, ...}`. Chrome ignores the whole policy if any setting isn't wrapped.

---

## Making changes

### Before you merge

1. Run `npm test` (Node 20+). The **Tests** action also runs it on every push and pull request, so a red ✖ on a commit or PR means don't merge it.
2. If you fixed a bug, add a test that fails without the fix. Tests live in `test/`:
   - `policy.test.mjs`: the extension's blocking rules and schedules
   - `crx.test.mjs`: signing and packaging
   - `dashboard.test.mjs`: the dashboard's server code, run against a fake Workspace, plus checks that `Index.html` will run inside Apps Script

### After you merge: what to do, and how you know it worked

| What changed | What to do | ✅ It worked if |
| --- | --- | --- |
| `extension/` | Merge to `main`. The **Publish extension** action builds and publishes it. | The action is green, and the Pages URL shows the new version. On the pilot Chromebook, after **Update** in `chrome://extensions` (developer mode), the popup shows the same version. |
| `dashboard/` | If you set up [automatic deploys](#automatic-dashboard-deploys-optional), merge to `main` and the **Deploy dashboard** action does it. Otherwise paste the changed files into the Apps Script editor (or `clasp push`), then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. | `diagnose` is all `OK`, and the `/exec` page loads your email and OUs. If the page looks frozen, press F12 and read the Console. |
| Rules or schedules (from the dashboard) | **Save** to the OU or group. | **Check a user** shows no red ✖. On the device, after **Reload policies**, the popup's mode and "Last checked" time update. |

### Pilot checklist

Run these on a pilot Chromebook after any change. Each should take seconds:

- [ ] The popup says "Settings from: Google Admin console" and shows the expected mode and schedules.
- [ ] A site on your blocked list (or any site not allowed, in allowlist mode) shows the blocked page.
- [ ] A site on your allowed list opens.
- [ ] Google sign-in still works: sign out of a site that uses "Sign in with Google" and sign back in.
- [ ] A link from an approved source opens (for example, a Classroom link to a site that's otherwise blocked).

If any of these fail, collect the two reports below.

## When a change doesn't reach a device

Collect two reports. Together they show where the chain breaks.

1. **Workspace side:** in the dashboard, enter the user's email under **Check a user** and click **Check**. It shows their OU and groups, whether the extension is force-installed for them, and which settings reach them. **Copy report** copies all of it.
2. **Device side:** on the user's Chromebook, click the extension's toolbar icon, then **Copy diagnostics**. It shows the extension version, the exact settings Chrome handed it, and the rules it's enforcing.

Reading them:
- Red items in the dashboard check → fix those first (often the user is in a different OU than the one you saved to, or the extension isn't force-installed there).
- No extension on the device → check `chrome://extensions` and `chrome://policy` on that device (Step 1b).
- `managedSettings` in the device report is empty or older than the dashboard → open `chrome://policy` on the device and click **Reload policies**, then copy diagnostics again.
- `managedSettings` matches but sites aren't blocked → the rules list shows what's enforced; compare it with what you expected.

`diagnose` in the Apps Script editor (pick it next to **Run**) checks the dashboard's own access to the Admin SDK and Chrome Policy API.

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
3. Run the tests with `npm test` (Node 20+). See [Making changes](#making-changes) for what they cover.

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
  "overridePassword": "pbkdf2-sha256$200000$<salt>$<hash>",
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

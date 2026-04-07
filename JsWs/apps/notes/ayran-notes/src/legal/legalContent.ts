export const TERMS_OF_SERVICE = `
# Terms of Service

**Ayran Notes** — Effective date: 2025-01-01

## 1. Acceptance of Terms

By using Ayran Notes, you agree to these Terms of Service. If you do not agree, please do not use the app.

## 2. Description of Service

Ayran Notes is a cross-platform note-taking application that stores your data exclusively on storage you control:
- Your device's local storage (folder you select)
- Cloud storage accounts you own (Google Drive, OneDrive, Dropbox, Filen.IO)

## 3. Your Data

**We do not collect, store, or process your personal data.** All notes, files, and preferences created by Ayran Notes are stored:
- On your local device in a folder you choose, or
- In your own cloud storage account using credentials you provide

Ayran Notes acts solely as a client application. We have no access to your notes or files.

## 4. Cloud Storage Permissions

When you choose a cloud storage provider, Ayran Notes requests full drive access. This is required to:
- Read and write note files
- Create and manage the notebook folder structure

These permissions are used exclusively for the notebook you designate. Access is managed by the respective cloud provider's authentication system.

## 5. Privacy and Personal Data

**Ayran Notes does not collect personal data.** See our Privacy Policy for details.

If you wish to "delete all personal data from this app", please note: all data created by this app lives on your own storage (your device or your cloud storage account). You may delete it at any time by:
- Deleting the notebook folder from your device or cloud storage
- Revoking the app's access in your cloud storage provider's settings

## 6. Intellectual Property

Ayran Notes and its source code are the intellectual property of their respective authors. You may not reverse engineer, copy, or redistribute the app without permission.

## 7. Disclaimer of Warranties

Ayran Notes is provided "as is" without warranty of any kind. We are not responsible for data loss. Always maintain backups of your important notes.

## 8. Limitation of Liability

To the maximum extent permitted by law, Ayran Notes and its creators shall not be liable for any indirect, incidental, or consequential damages arising from your use of the app.

## 9. Changes to Terms

We may update these Terms from time to time. Continued use after changes constitutes acceptance of the new Terms.
`;

export const PRIVACY_POLICY = `
# Privacy Policy

**Ayran Notes** — Effective date: 2025-01-01

## 1. Data We Collect

**We collect no personal data.** Ayran Notes does not have servers, does not send your data to third parties, and does not track usage.

## 2. Data Stored on Your Device

Ayran Notes stores the following locally on your device:
- **Session information**: Which notebooks you have open, tab state, and UI preferences. This is stored in the app's private data directory on your device.
- **OAuth tokens**: Authentication tokens for cloud storage providers you connect. These are stored securely in your device's secure storage (Keychain on iOS, Keystore on Android).

## 3. Cloud Storage

When you use a cloud storage provider (Google Drive, OneDrive, Dropbox, Filen.IO):
- Ayran Notes authenticates with that provider using OAuth 2.0 or the provider's authentication mechanism.
- All note files and data are stored in your cloud storage account, governed by that provider's privacy policy.
- Ayran Notes does not share your cloud storage credentials with anyone.

## 4. GDPR (European Users)

Under GDPR, you have the right to access, correct, or delete your personal data. Since Ayran Notes stores no personal data on our servers, there is nothing for us to delete. All data is in your control.

To delete your data:
- Remove the notebook folder from your storage (device or cloud)
- Revoke app permissions in your cloud storage provider's settings
- Uninstall the app (removes local session data)

## 5. Third-Party Services

Ayran Notes integrates with the following third-party storage providers. Their privacy policies apply to data stored with them:
- Google Drive: https://policies.google.com/privacy
- Microsoft OneDrive: https://privacy.microsoft.com
- Dropbox: https://www.dropbox.com/privacy
- Filen.IO: https://filen.io/privacy

## 6. Children's Privacy

Ayran Notes is not directed at children under 13. We do not knowingly collect information from children.

## 7. Changes to This Policy

We may update this policy. Changes will be posted in the app's next update.

## 8. Contact

For questions about this Privacy Policy, please visit the project's repository.
`;

export const DATA_NOTICE = `
# Personal Data Notice

Ayran Notes does **not** store any personal data on external servers.

All your notes, preferences, and files are stored either:
- On your device in a folder you choose
- In your cloud storage account (Google Drive, OneDrive, Dropbox, or Filen.IO)

**This app cannot "delete your data from our servers"** because we have no servers and your data never leaves your control.

To remove all data associated with this app:
1. Delete the notebook folder from your storage location
2. Go to your cloud provider settings and revoke Ayran Notes' access
3. Uninstall the app to remove local session data
`;

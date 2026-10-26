# Virtual Disk — CloudFlare-ImgBed d2tunnel-disk

This feature provides logical multi-level directories, breadcrumbs, partitions, cross-partition/collaborator moves and copies, opt-in public static resources, capability shares, read/write collaborator credentials and a subset of AWS S3-compatible APIs.

**UI:** https://YOUR-DOMAIN/disk.html  
**Share UI:** https://YOUR-DOMAIN/disk-share.html?token=...  

The original ImgBed uploader is unchanged. Upload an object through ImgBed, then attach its existing file ID to a virtual disk directory. This **does not re-upload** Telegram/Discord chunks or move the physical provider bytes. Virtual copies link to the same original source ID; physical provider changes in the original ImgBed administration UI can invalidate links.

## Cloudflare Pages deployment

1. Bind a Cloudflare D1 database under the **binding name img_d1** (Pages project → Settings → Bindings → D1). This is required by the virtual disk metadata model. Existing ImgBed KV metadata can remain in the existing img_url KV binding; there is no migration of old ImgBed file records.
2. Apply the schema to this binding (once):

    npx wrangler d1 execute YOUR_D1_DATABASE_NAME --remote --file=database/migrations/v2.8.0_disk.sql

    For a new ImgBed D1 setup, also initialize the original schema from database/init.sql. Do not drop or reset an existing database.
3. Optionally bind R2 storage as **img_r2** (needed to use S3 PutObject; R2-backed ImgBed files also use the original img_r2 binding).
4. Deploy the existing repository with Pages Functions. The functions/ directory is auto-discovered, and frontend-dist/disk.html and frontend-dist/disk-share.html are ordinary Pages static assets.

## Cloudflare Workers deployment

1. Configure the same img_d1 D1 and optional img_r2 R2 bindings in deploy/worker/wrangler.toml, keeping the original Pages-style functions.
2. Apply the same D1 migration to the bound D1 database.
3. Use the existing Workers build/deploy command (npm run deploy:worker). Its route generator discovers the new functions/s3, functions/api/disk, functions/disk-static, and functions/api/disk-share entry points. The existing Workers asset binding serves both HTML pages.
4. Use only encrypted Cloudflare environment secrets for DISK_S3_ACCESS_KEY and DISK_S3_SECRET_KEY if the S3 gateway is enabled.

Both deployment targets reuse standard Web APIs and D1/R2; there are **no Node.js-only runtime dependencies** in the new cloud code. The pre-existing Docker deployment uses its own SQLite/D1 emulator locally; the cloud deployment does not depend on that emulator.

## Browser operations

- New partition: create a dedicated virtual namespace. A folder path is relative to one partition and can be nested arbitrarily (within the current path length limits).
- Attach an ImgBed file: paste its existing file ID. Its original storage channel and upload are preserved.
- Rename/move/copy: operate on virtual nodes. Cross-partition moves copy the virtual tree then unlink its old references, preserving the original uploaded bytes.
- Collaborate: administrator creates a scoped read/write token per partition and shares it through a trusted channel. Enter the token under 协同密钥 in the disk UI. A write grant can modify the destination; moving also requires a write grant to the source. Viewers can obtain short-lived preview links for browser media elements.
- Share: create a token for one file or folder subtree, optionally with expiry. Revoke it through DELETE /api/disk/shares. Share pages cannot escape the selected subtree.
- Static resources: enable an individual file's is_public flag; GET/HEAD /disk-static/:space/:path reads it through the existing ImgBed file reader. Non-public paths return 404.
- Preview: image, video, audio, text, PDF via the original ImgBed file reader. Single byte-range requests are supported for original provider paths that offer Range, including the current R2 and chunk reader logic.

## Management API

| Method/path | Description |
|---|---|
| GET, POST /api/disk/spaces | List/create partitions |
| POST /api/disk/space | Rename/delete a partition (administrator) |
| GET /api/disk/browse?space=ID&path=PATH | List direct children, crumbs |
| POST /api/disk/mkdir | Create a persistent empty folder |
| POST /api/disk/import | Associate an existing ImgBed file ID |
| POST /api/disk/rename | Rename a file or directory |
| POST /api/disk/transfer | Copy/move a virtual file or directory subtree across partitions |
| DELETE /api/disk/node?space=ID&path=PATH | Remove a virtual subtree |
| POST /api/disk/public | Enable/disable individual static file link |
| GET, POST, DELETE /api/disk/grants | Administrator: issue/list/revoke collaborators |
| GET, POST, DELETE /api/disk/shares | Issue/list/revoke capability shares |
| GET /api/disk/shared?token=T&path=PATH | Public capability listing |
| POST /api/disk/preview | Make a 5-minute read-only media capability |
| GET /api/disk/source | Source-related file preview links |
| GET, HEAD /api/disk-share/:token/:subpath | Public share file stream |
| GET, HEAD /disk-static/:space/:path | Explicitly public static file stream |

A collaborator sends X-Disk-Token: <64-hex token> or Authorization: Bearer <token>. For cross-partition collaboration, X-Disk-Token accepts up to eight comma-separated grant keys in one request; the source and destination grants are validated independently. Tokens are SHA-256 hashes at rest and created with cryptographic randomness. Original blocked/restricted media remain subject to ImgBed's normal security policy even when a virtual share exists.

## S3 gateway

Path-style endpoint: https://YOUR-DOMAIN/s3  
Bucket name: the virtual partition UUID (ListBuckets lists the UUIDs).  
Authorization: AWS Signature V4 via Authorization header or X-Amz presigned URL, configured with encrypted DISK_S3_ACCESS_KEY / DISK_S3_SECRET_KEY environment variables.

Implemented: ListBuckets, HeadBucket, ListObjects, ListObjectsV2, GetObject, HeadObject, PutObject (requires R2), DeleteObject (virtual unlink), CopyObject (virtual metadata copy), GET byte ranges, ETag for new R2 objects. PUT of large signed-hash payloads requires unsigned-payload streaming mode or the original ImgBed uploader.

**Not implemented (S3 subset, not full S3 parity):** CreateBucket, DeleteBucket, S3 multipart-upload protocol, bucket ACL/IAM, versioning, object tagging, universal overwrite behavior, complete AWS conditional request matrix, native external-provider PUT. S3 credentials currently grant access to all disk partitions; they are not individual collaborator permissions.

## Safety and limitations

- Administrator security **must be configured**: when admin authentication is unconfigured, the original ImgBed management-auth policy allows administrative access.
- D1 disk schema must be migrated separately for each Cloudflare deployment environment. The virtual disk will report DISK_D1_REQUIRED if D1 is absent.
- Virtual operations use D1, not distributed object moves. Cross-partition operations copy up to 2,000 virtual nodes and do not provide a single transaction spanning multi-node copy; failures attempt destination rollback without deleting source objects.
- Deleting original ImgBed source records can break references; reference counts and physical garbage collection are not coordinated with ImgBed's original delete interface.
- Sharing a file cannot override existing ImgBed block lists or public whitelist restrictions.
- S3 object upload is limited to R2. It does not replace the ImgBed upload flow.
- New disk UI is a separate page because this branch contains compiled frontend-dist assets, not the editable frontend source tree.
- Running new code under Workers/Pages has been designed for compatibility, but live Cloudflare deployment, user-account authorization configurations and third-party S3 SDK interoperability require end-to-end testing in an actual environment.

## Local verification

Use Node.js 22 and install dependencies first.

    npm ci
    npm test
    npm run test:server
    npx --no-install wrangler pages functions build functions --outdir data/ci-pages-build

The repository's regression workflow now runs for pushes to d2tunnel-disk as well as dev and main.

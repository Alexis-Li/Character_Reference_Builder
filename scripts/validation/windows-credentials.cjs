// Node 24: exercise the actual product store, never a user's credential file.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createProtectedFileCredentialStore } = require("../../src/lib/security/credentialStore.server.ts");
const usage = "node scripts/validation/windows-credentials.cjs owner|foreign|verify <new-test-directory>\nWindows and Node 24 required. Synthetic data only. See windows-dpapi.ps1 for isolated hosted-runner orchestration.";
if (process.argv.includes("--help")) { console.log(usage); process.exit(0); }
const [mode, directory] = process.argv.slice(2);
assert.equal(process.platform, "win32", "This verification requires Windows DPAPI");
assert.ok(["owner", "foreign", "verify"].includes(mode) && directory, usage);
const root = path.resolve(directory);
assert.ok(path.basename(root).startsWith("crb-dpapi-"), "Use a new crb-dpapi-* test directory");
const file = path.join(root, "owner.dpapi");
const manifest = path.join(root, "synthetic-manifest.json");
const result = path.join(root, "result.json");
const synthetic = "CRB synthetic credential only — 非真实凭据";
const hash = value => createHash("sha256").update(value).digest("hex");
function powershell(script, input = "") {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
}
function sid() {
  const output = powershell("[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)");
  assert.equal(output.status, 0, "Cannot establish test identity");
  assert.match(output.stdout.trim(), /^S-1-/);
  return output.stdout.trim();
}
(async () => {
  if (mode === "owner") {
    await fs.mkdir(root, { recursive: false }); // refuse to reuse any existing data
    const store = createProtectedFileCredentialStore(file);
    await store.set("synthetic", synthetic);
    assert.equal(await createProtectedFileCredentialStore(file).get("synthetic"), synthetic);
    const bytes = await fs.readFile(file);
    assert.ok(!bytes.includes(Buffer.from(synthetic)), "Store must contain ciphertext");
    await fs.writeFile(manifest, JSON.stringify({ ownerSid: sid(), digest: hash(bytes) }), { flag: "wx" });
    console.log("Owner product-store round trip passed; only synthetic ciphertext prepared.");
  } else if (mode === "foreign") {
    const owner = JSON.parse(await fs.readFile(manifest, "utf8"));
    assert.notEqual(sid(), owner.ownerSid, "A second process under the same user is not a cross-user test");
    const bytes = await fs.readFile(file); // prove this is not merely an ACL refusal
    assert.equal(hash(bytes), owner.digest);
    const ownFile = path.join(root, "foreign-control.dpapi");
    const ownStore = createProtectedFileCredentialStore(ownFile);
    await ownStore.set("synthetic", synthetic);
    assert.equal(await createProtectedFileCredentialStore(ownFile).get("synthetic"), synthetic,
      "Second user's own DPAPI must work; a broken or unloaded profile is not isolation evidence");
    const native = powershell("Add-Type -AssemblyName System.Security; try { [void][Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); exit 0 } catch { if ($_.Exception.GetBaseException() -is [Security.Cryptography.CryptographicException]) { exit 23 }; exit 24 }", bytes.toString("utf8"));
    assert.equal(native.status, 23, "Native DPAPI must reject foreign ciphertext with a cryptographic failure");
    assert.equal(await createProtectedFileCredentialStore(file).get("synthetic"), null);
    assert.deepEqual(await createProtectedFileCredentialStore(file).keys(), []);
    assert.equal(hash(await fs.readFile(file)), owner.digest, "Rejected reads must not overwrite the owner's data");
    await ownStore.delete("synthetic");
    await fs.writeFile(result, JSON.stringify({ status: "pass", differentWindowsIdentity: true, foreignCanReadCiphertext: true,
      ownerRoundTrip: true, foreignOwnRoundTrip: true, nativeForeignDecryptRejected: true, productForeignReadEmpty: true,
      ownerCiphertextUnchanged: true, realCredentialsUsed: false }, null, 2));
    console.log("Foreign identity, readable ciphertext, independent positive control and product rejection passed.");
  } else {
    const owner = JSON.parse(await fs.readFile(manifest, "utf8"));
    assert.equal(sid(), owner.ownerSid);
    assert.equal(hash(await fs.readFile(file)), owner.digest);
    const store = createProtectedFileCredentialStore(file);
    assert.equal(await store.get("synthetic"), synthetic, "Owner must still decrypt after foreign rejection");
    await store.delete("synthetic");
    assert.deepEqual(await store.keys(), []);
    const report = JSON.parse(await fs.readFile(result, "utf8"));
    assert.equal(report.status, "pass");
    report.ownerStillDecryptsAfterForeignRejection = true;
    await fs.writeFile(result, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

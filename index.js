#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const unzipper = require("unzipper");
const archiver = require("archiver");

const FILE_NAME = "package-diff.xml";
const SF_ROOT = findSfProjectRoot(__dirname);

// ------------------------------
// METADATA MAPPING
// ------------------------------
const mapping = {
    simple: [
        { dir: "/classes/", ext: ".cls", type: "ApexClass" },
        { dir: "/triggers/", ext: ".trigger", type: "ApexTrigger" },
        { dir: "/customMetadata/", ext: ".md-meta.xml", type: "CustomMetadata" },
        { dir: "/flexiPage/", ext: ".flexipage-meta.xml", type: "FlexiPage" },
        { dir: "/customObject/", ext: ".object-meta.xml", type: "CustomObject" },
        { dir: "/layouts/", ext: ".layout-meta.xml", type: "Layout" },
        { dir: "/permissionsets/", ext: ".permissionset-meta.xml", type: "PermissionSet" },
    ],
    bundle: [
        { dir: "/lwc/", bundle: "lwc", type: "LightningComponentBundle" },
        { dir: "/aura/", bundle: "aura", type: "AuraDefinitionBundle" },
    ],
};

// ------------------------------
// ENTRY
// ------------------------------
run();

function run() {
    parseArgs();
}

// ------------------------------
// ARGUMENT HANDLING
// ------------------------------
function parseArgs() {
    const args = process.argv.slice(2);

    if (!args.length) {
        console.log("Usage: node index.js -b <branch> | -cs <changeSetName>");
        process.exit(1);
    }

    const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : null;
    };

    if (args.includes("-b")) {
        generateDiffPackage(getArg("-b"));
    }

    if (args.includes("-cs")) {
        createChangeSet(getArg("-cs"));
    }
}

// ------------------------------
// DIFF PACKAGE GENERATION
// ------------------------------
function generateDiffPackage(targetBranch) {
    if (!targetBranch) {
        console.error("❌ Missing required parameter: -b <branch>");
        process.exit(1);
    }

    const currentBranch = getCurrentBranch();
    console.log(`🔍 Comparing "${currentBranch}" → "${targetBranch}"`);

    const files = getChangedFiles(currentBranch, targetBranch);
    if (!files.length) {
        console.log("No changes detected");
        process.exit(0);
    }

    const metadata = files.map(mapToMetadata).filter(Boolean);
    const grouped = groupMetadata(metadata);

    const xml = generatePackageXML(grouped);

    const outputPath = path.join(__dirname, "../manifest", FILE_NAME);
    fs.writeFileSync(outputPath, xml);

    console.log(`✅ ${FILE_NAME} created`);
}

// ------------------------------
// CHANGE SET CREATION
// ------------------------------
async function createChangeSet(changeSetName) {
    if (!changeSetName) {
        console.error("❌ Missing required parameter: -cs <name>");
        process.exit(1);
    }

    console.log(`📦 Creating Change Set: ${changeSetName}`);
    retrieveMetadata();
    await extractPackage();
    updatePackageXML(changeSetName);
    await zipPackage();
    deployPackage();
    deleteRetrievedSource();
}

// ------------------------------
// METADATA RETRIEVAL
// ------------------------------
function retrieveMetadata() {
    try {
        execSync(
            `sf project retrieve start --target-metadata-dir retrievedSource --manifest ../manifest/${FILE_NAME}`,
            { stdio: "inherit" }
        );
        console.log("✅ Metadata retrieved");
    } catch (err) {
        console.error("❌ Retrieval failed:", err.message);
        process.exit(1);
    }
}

// ------------------------------
// EXTRACTION
// ------------------------------
function extractPackage() {
    const zipPath = path.join(__dirname, "retrievedSource", "unpackaged.zip");
    const extractPath = path.join(__dirname, "retrievedSource");

    return new Promise((resolve, reject) => {
        fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: extractPath }))
            .on("close", () => {
                console.log("✅ Extracted:", extractPath);

                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

                resolve();
            })
            .on("error", reject);
    });
}

// ------------------------------
// UPDATE PACKAGE.XML
// ------------------------------
function updatePackageXML(changeSetName) {
    const packagePath = path.join("retrievedSource", "unpackaged", "package.xml");

    let xml = fs.readFileSync(packagePath, "utf8");

    xml = xml.replace(
        '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
        `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>${changeSetName}</fullName>`
    );

    fs.writeFileSync(packagePath, xml, "utf8");

    console.log("✅ package.xml updated");
}

// ------------------------------
// ZIP BACK
// ------------------------------
function zipPackage() {
    const folder = path.join("retrievedSource", "unpackaged");
    const outputZip = path.join("retrievedSource", "final.zip");

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputZip);
        const archive = archiver("zip", { zlib: { level: 9 } });

        archive.pipe(output);
        archive.directory(folder, false);
        archive.finalize();

        output.on("close", () => {
            console.log(`✅ ZIP created: ${outputZip}`);
            resolve();
        });

        archive.on("error", reject);
    });
}

// ------------------------------
// DEPLOY
// ------------------------------
function deployPackage() {
    const zipPath = "retrievedSource/final.zip";

    console.log("🚀 Deploying...");

    execSync(
        `sf project deploy start --single-package --metadata-dir ${zipPath}`,
        { stdio: "inherit" }
    );

    console.log("✅ Deployment finished");
}

// ------------------------------
// GIT HELPERS
// ------------------------------
function getCurrentBranch() {
    return execSync("git rev-parse --abbrev-ref HEAD", {
        encoding: "utf8",
        cwd: SF_ROOT,
    }).trim();
}

function getChangedFiles(currentBranch, targetBranch) {
    const diff = execSync(
        `git diff --name-only --diff-filter=AM $(git merge-base ${currentBranch} ${targetBranch}) ${currentBranch}`,
        { encoding: "utf8", cwd: SF_ROOT }
    );

    return diff.split("\n").filter(Boolean);
}

function mapToMetadata(file) {
    const parts = file.split("/");

    const getName = (suffix) => parts.pop().replace(suffix, "");
    const getBundle = (folder) => parts[parts.indexOf(folder) + 1];

    for (const r of mapping.simple) {
        if (file.includes(r.dir) && file.endsWith(r.ext)) {
            return { type: r.type, name: getName(r.ext) };
        }
    }

    for (const r of mapping.bundle) {
        if (file.includes(r.dir)) {
            return { type: r.type, name: getBundle(r.bundle) };
        }
    }

    if (file.includes("/staticresources/")) {
        const f = parts[parts.indexOf("staticresources") + 1].split(".")[0];
        return { type: "StaticResource", name: f };
    }

    return null;
}

function groupMetadata(items) {
    const grouped = {};

    items.forEach((i) => {
        if (!grouped[i.type]) grouped[i.type] = new Set();
        grouped[i.type].add(i.name);
    });

    for (const t in grouped) {
        grouped[t] = [...grouped[t]].sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase())
        );
    }

    return grouped;
}

function generatePackageXML(grouped) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';

    for (const type of Object.keys(grouped)) {
        xml += `  <types>\n`;
        grouped[type].forEach((name) => {
            xml += `    <members>${name}</members>\n`;
        });
        xml += `    <name>${type}</name>\n`;
        xml += `  </types>\n\n`;
    }

    xml += `  <version>63.0</version>\n`;
    xml += `</Package>\n`;

    return xml;
}

function deleteRetrievedSource() {
    const folder = path.join(__dirname, "retrievedSource");

    if (!fs.existsSync(folder)) {
        return;
    }

    fs.rmSync(folder, { recursive: true, force: true });
}

// ------------------------------
// FIND SF ROOT
// ------------------------------
function findSfProjectRoot(startDir) {
    let dir = startDir;

    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, "force-app"))) {
            return dir;
        }
        dir = path.dirname(dir);
    }

    throw new Error("❌ Salesforce project root not found.");
}

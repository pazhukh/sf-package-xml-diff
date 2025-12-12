#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const unzipper = require("unzipper");
const archiver = require("archiver");

const PACKAGE_DIFF_XML = "package-diff.xml";
const SF_ROOT = findSfProjectRoot(__dirname);

const RETRIEVE_FOLDER = 'retrievedSource';
const BRANCH_FLAG = '-b';
const CHANGESET_FLAG = '-cs';

const mapping = {
    simple: [
        { dir: "/classes/", ext: ".cls", type: "ApexClass" },
        { dir: "/triggers/", ext: ".trigger", type: "ApexTrigger" },
        { dir: "/customMetadata/", ext: ".md-meta.xml", type: "CustomMetadata" },
        { dir: "/flexipages/", ext: ".flexipage-meta.xml", type: "FlexiPage" },
        { dir: "/customObject/", ext: ".object-meta.xml", type: "CustomObject" },
        { dir: "/layouts/", ext: ".layout-meta.xml", type: "Layout" },
        { dir: "/permissionsets/", ext: ".permissionset-meta.xml", type: "PermissionSet" },
    ],
    bundle: [
        { dir: "/lwc/", bundle: "lwc", type: "LightningComponentBundle" },
        { dir: "/aura/", bundle: "aura", type: "AuraDefinitionBundle" },
    ],
    combo: [
        { dir: "/fields/", ext: ".field-meta.xml", type: "CustomField" },
        { dir: "/fieldSets/", ext: ".fieldSet-meta.xml", type: "FieldSet" },
        { dir: "/validationRules/", ext: ".validationRule-meta.xml", type: "ValidationRule" },
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
        console.log(`Usage: node index.js ${BRANCH_FLAG} <branch> | ${CHANGESET_FLAG} <changeSetName>`);
        process.exit(1);
    }

    const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : null;
    };

    if (args.includes(BRANCH_FLAG)) {
        generateDiffPackage(getArg(BRANCH_FLAG));
    }

    if (args.includes(CHANGESET_FLAG)) {
        updateChangeSet(getArg(CHANGESET_FLAG));
    }
}

// ------------------------------
// DIFF PACKAGE GENERATION
// ------------------------------
function generateDiffPackage(targetBranch) {
    if (!targetBranch) {
        console.error(`❌ Missing required parameter: ${BRANCH_FLAG} <branch>`);
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

    const outputPath = path.join(__dirname, PACKAGE_DIFF_XML);
    fs.writeFileSync(outputPath, xml);

    console.log(`✅ ${PACKAGE_DIFF_XML} created`);
}

async function updateChangeSet(changeSetName) {
    if (!changeSetName) {
        console.error(`❌ Missing required parameter: ${CHANGESET_FLAG} <name>`);
        process.exit(1);
    }

    try {
        retrieveMetadata();
        await extractPackage();
        updatePackageXML(changeSetName);
        await zipPackage();
        deployPackage();

        console.log(`✅ Change set "${changeSetName}" is updated successfully`);

    } catch (error) {
        console.error(`❌ Error: ${error}`);
    } finally {
        deleteSources();
    }
}

function retrieveMetadata() {
    try {
        console.log("🔍 Retrieving metadata...\n");
        execSync(
            `sf project retrieve start --target-metadata-dir ${RETRIEVE_FOLDER} --manifest ${PACKAGE_DIFF_XML}`,
            { stdio: "inherit" }
        );
        console.log("\n✅ Metadata retrieved");
    } catch (err) {
        console.error("❌ Retrieval failed:", err.message);
        process.exit(1);
    }
}

function extractPackage() {
    const zipPath = path.join(__dirname, RETRIEVE_FOLDER, "unpackaged.zip");
    const extractPath = path.join(__dirname, RETRIEVE_FOLDER);

    return new Promise((resolve, reject) => {
        fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: extractPath }))
            .on("close", () => {
                console.log("✅ Zip extracted");

                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

                resolve();
            })
            .on("error", reject);
    });
}

function updatePackageXML(changeSetName) {
    const packagePath = path.join(RETRIEVE_FOLDER, "unpackaged", "package.xml");

    let xml = fs.readFileSync(packagePath, "utf8");

    xml = xml.replace(
        '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
        `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>${changeSetName}</fullName>`
    );

    fs.writeFileSync(packagePath, xml, "utf8");

    console.log("✅ package.xml updated");
}

function zipPackage() {
    const folder = path.join(RETRIEVE_FOLDER, "unpackaged");
    const outputZip = path.join(RETRIEVE_FOLDER, "final.zip");

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputZip);
        const archive = archiver("zip", { zlib: { level: 9 } });

        archive.pipe(output);
        archive.directory(folder, false);
        archive.finalize();

        output.on("close", () => {
            console.log(`✅ ZIP created`);
            resolve();
        });

        archive.on("error", reject);
    });
}

function deployPackage() {
    const zipPath = `${RETRIEVE_FOLDER}/final.zip`;

    console.log("🚀 Deploying to the Org...\n");

    execSync(
        `sf project deploy start --single-package --metadata-dir ${zipPath}`,
        { stdio: "inherit" }
    );

    console.log("✅ Deployment finished");
}

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

    for (const r of mapping.combo) {
        if (file.includes(r.dir) && file.endsWith(r.ext)) {
            return { type: r.type, name: extractObjectMemberName(file) };
        }
    }

    if (file.includes("/staticresources/")) {
        const f = parts[parts.indexOf("staticresources") + 1].split(".")[0];
        return { type: "StaticResource", name: f };
    }

    if (file.includes("/dashboards/") && file.endsWith(".dashboard-meta.xml")) {
        const f = file
                .split("/dashboards/")[1]
                .replace(".dashboard-meta.xml", "");
        return { type: "Dashboard", name: f };
    }

    return null;
}

function extractObjectMemberName(fullPath) {
    // Find the part after "objects/"
    const afterObjects = fullPath.split("/objects/")[1];
    if (!afterObjects) return null;

    const parts = afterObjects.split("/");

    const objectName = parts[0];
    const fileName = parts[2];

    // Strip any ".xxxx-meta.xml"
    const stripped = fileName.replace(/\.([a-zA-Z]+-)?meta\.xml$/, "");

    return `${objectName}.${stripped}`;
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

function deleteSources() {
    const folder = path.join(__dirname, RETRIEVE_FOLDER);
    const packageFile = path.join(__dirname, PACKAGE_DIFF_XML);

    if (fs.existsSync(folder)) {
        fs.rmSync(folder, { recursive: true, force: true });
    }

    if (fs.existsSync(packageFile)) {
        fs.rmSync(packageFile, { force: true });
    }
}

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

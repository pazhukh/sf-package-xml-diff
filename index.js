const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const fileName = 'package-diff.xml';

// Map file paths to Salesforce metadata types
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
        { dir: "/lwc/", bundle: 'lwc', type: "LightningComponentBundle" },
        { dir: "/aura/", bundle: 'aura', type: "AuraDefinitionBundle" },
    ],
}

// Main execution
run();
function run() {
    parseArgs();
}

function generateDiffPackage(targetBranch) {
    if (targetBranch === undefined) {
        console.error("❌ Missing required parameter: -b <branch>");
        process.exit(1);
    }

    const currentBranch = getCurrentBranch();

    console.log(`🔍 Comparing "${currentBranch}" branch to "${targetBranch}"`);

    const files = getChangedFiles(currentBranch, targetBranch);
    console.log("Changed files:", files.length);

    const metadata = files
        .map(mapToMetadata)
        .filter(Boolean);

    const grouped = groupMetadata(metadata);
    const xml = generatePackageXML(grouped);

    const outputPath = path.join(__dirname, "manifest", fileName);
    fs.writeFileSync(outputPath, xml);
    console.log(`✅ ${path.relative(__dirname, outputPath)} created!`);
}

// Get name of the current git branch
function getCurrentBranch() {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
}

// Get list of changed files between two branches
function getChangedFiles(currentBranch, targetBranch) {
    const diff = execSync(
        `git diff --name-only --diff-filter=AM $(git merge-base ${currentBranch} ${targetBranch}) ${currentBranch}`,
        { encoding: "utf8" }
    );
    return diff.split("\n").filter(Boolean);
}

function mapToMetadata(file) {
    const parts = file.split("/");

    // ---- Helpers ----
    const getName = (suffix) => parts.pop().replace(suffix, "");
    const getBundleName = (folder) => parts[parts.indexOf(folder) + 1];

    for (const rule of mapping.simple) {
        if (file.includes(rule.dir) && file.endsWith(rule.ext)) {
            return {
                type: rule.type,
                name: getName(rule.ext)
            };
        }
    }

    for (const rule of mapping.bundle) {
        if (file.includes(rule.dir)) {
            return {
                type: rule.type,
                name: getBundleName(rule.bundle)
            }
        }
    }

    // STATIC RESOURCES
    if (file.includes("/staticresources/")) {
        const parts = file.split("/");
        const folderName = parts[parts.indexOf("staticresources") + 1];
        console.log(folderName);
        const cleanName = folderName.split('.')[0];
        return { type: "StaticResource", name: cleanName};
    }

    return null;
}

// Group by metadata type
function groupMetadata(changes) {
    const grouped = {};
    changes.forEach(item => {
        if (!grouped[item.type]) grouped[item.type] = new Set();
        grouped[item.type].add(item.name);
    });

    // sort alphabeticaly
    for (const type in grouped) {
        grouped[type] = Array.from(grouped[type]).sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase())
        );
    }

    return grouped;
}

// Generate package.xml content
function generatePackageXML(groupedMetadata) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';

    Object.keys(groupedMetadata).forEach(type => {
        xml += `  <types>\n`;
        [...groupedMetadata[type]].forEach(name => {
            xml += `    <members>${name}</members>\n`;
        });
        xml += `    <name>${type}</name>\n`;
        xml += `  </types>\n\n`;
    });

    xml += `  <version>63.0</version>\n`;
    xml += `</Package>\n`;

    return xml;
}

function parseArgs() {
    const args = process.argv.slice(2);

    const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : null;
    };
    
    const bIndex = args.indexOf("-b");
    if (bIndex !== -1) {
        const targetBranch = getArg("-b");
        generateDiffPackage(targetBranch);
    }
}

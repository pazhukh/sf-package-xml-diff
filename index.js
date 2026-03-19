#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const unzipper = require("unzipper");
const archiver = require("archiver");

const PACKAGE_DIFF_XML = "package-diff.xml";
const SF_ROOT = findSfProjectRoot(__dirname);

let TARGET_ORG;

const RETRIEVE_FOLDER = 'retrievedSource';
const HELP_FLAG_SHORT = '-h';
const HELP_FLAG = '--help';

const BRANCH_FLAG_SHORT = '-b';
const BRANCH_FLAG = '--branch';

const RETRIEVE_ONLY_FLAG_SHORT = '-r';
const RETRIEVE_ONLY_FLAG = '--retrieve-only';

const DEPLOY_FLAG_SHORT = '-d';
const DEPLOY_FLAG = '--deploy';

const TARGET_ORG_FLAG_SHORT = '-o';
const TARGET_ORG_FLAG = '--target-org';

const mapping = {
    singleFiles: [
        { dir: "/classes/", ext: ".cls", type: "ApexClass" },
        { dir: "/triggers/", ext: ".trigger", type: "ApexTrigger" },
        { dir: "/customMetadata/", ext: ".md-meta.xml", type: "CustomMetadata" },
        { dir: "/flexipages/", ext: ".flexipage-meta.xml", type: "FlexiPage" },
        { dir: "/objects/", ext: ".object-meta.xml", type: "CustomObject" },
        { dir: "/layouts/", ext: ".layout-meta.xml", type: "Layout" },
        { dir: "/permissionsets/", ext: ".permissionset-meta.xml", type: "PermissionSet" },
        { dir: "/reportTypes/", ext: ".reportType-meta.xml", type: "ReportType" },
        { dir: "/flows/", ext: ".flow-meta.xml", type: "Flow" },
    ],
    bundleTypes: [
        { dir: "/lwc/", bundle: "lwc", type: "LightningComponentBundle" },
        { dir: "/aura/", bundle: "aura", type: "AuraDefinitionBundle" },
    ],
    objectChildren: [
        { dir: "/fields/", ext: ".field-meta.xml", type: "CustomField" },
        { dir: "/fieldSets/", ext: ".fieldSet-meta.xml", type: "FieldSet" },
        { dir: "/validationRules/", ext: ".validationRule-meta.xml", type: "ValidationRule" },
        { dir: "/webLinks/", ext: ".webLink-meta.xml", type: "WebLink" },
        { dir: "/listViews/", ext: ".listView-meta.xml", type: "ListView" },
    ],
    folderBased: [
        { dir: "/dashboards/", ext: ".dashboard-meta.xml", type: "Dashboard" },
        { dir: "/reports/", ext: ".report-meta.xml", type: "Report" },
    ]
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

    const supportedFlags = [
        HELP_FLAG, HELP_FLAG_SHORT,
        BRANCH_FLAG, BRANCH_FLAG_SHORT,
        RETRIEVE_ONLY_FLAG, RETRIEVE_ONLY_FLAG_SHORT,
        DEPLOY_FLAG, DEPLOY_FLAG_SHORT,
        TARGET_ORG_FLAG, TARGET_ORG_FLAG_SHORT
    ];

    const isHelpFlag = args.includes(HELP_FLAG) || args.includes(HELP_FLAG_SHORT);

    if (!args.length || isHelpFlag) {
        showHelp();
    }

    // Check for unsupported flags
    const inputFlags = args.filter(arg => arg.startsWith('-'));
    const allUnsupported = inputFlags.length && inputFlags.every(f => !supportedFlags.includes(f));
    if (allUnsupported) {
        showHelp();
    }


    const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : null;
    };

    const isBranchFlag = args.includes(BRANCH_FLAG) || args.includes(BRANCH_FLAG_SHORT);
    if (!isBranchFlag) {
        console.error(`❌ Missing required parameter: ${BRANCH_FLAG} <branch>`);
        process.exit(1);
    }

    TARGET_ORG = getArg(TARGET_ORG_FLAG) || getArg(TARGET_ORG_FLAG_SHORT);
    if (!TARGET_ORG) {
        console.error(`❌ Missing required parameter: ${TARGET_ORG_FLAG} <targetOrg>`);
        process.exit(1);
    }

    const branchName = getArg(BRANCH_FLAG) || getArg(BRANCH_FLAG_SHORT);
    const isDeployFlag = args.includes(DEPLOY_FLAG) || args.includes(DEPLOY_FLAG_SHORT);
    const isRetrieveFlag = args.includes(RETRIEVE_ONLY_FLAG) || args.includes(RETRIEVE_ONLY_FLAG_SHORT);

    generateDiffPackage(branchName);

    if (isDeployFlag) {
        const changeSetName = getArg(DEPLOY_FLAG) || getArg(DEPLOY_FLAG_SHORT);
        updateChangeSet(changeSetName);
    } else if (isRetrieveFlag) {
        retrieveMetadata(true);
    }
}

// ------------------------------
// DIFF PACKAGE GENERATION
// ------------------------------
function generateDiffPackage(targetBranch) {
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
        console.error(`❌ Missing required parameter: ${DEPLOY_FLAG} <name>`);
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

function retrieveMetadata(diffOnly) {
    try {
        console.log("🔍 Retrieving metadata...\n");
        if (diffOnly) {
            execSync(
                `sf project retrieve start --manifest ${PACKAGE_DIFF_XML} ${getTargetOrg()}`,
                { stdio: "inherit" }
            );
            deleteSources();
        } else {
            execSync(
                `sf project retrieve start --target-metadata-dir ${RETRIEVE_FOLDER} --manifest ${PACKAGE_DIFF_XML} ${getTargetOrg()}`,
                { stdio: "inherit" }
            );
        }
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
        `sf project deploy start --single-package --metadata-dir ${zipPath} ${getTargetOrg()}`,
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

    for (const r of mapping.singleFiles) {
        if (file.includes(r.dir) && file.endsWith(r.ext)) {
            return { type: r.type, name: getName(r.ext) };
        }
    }

    for (const r of mapping.bundleTypes) {
        if (file.includes(r.dir)) {
            return { type: r.type, name: getBundle(r.bundle) };
        }
    }

    for (const r of mapping.objectChildren) {
        if (file.includes(r.dir) && file.endsWith(r.ext)) {
            return { type: r.type, name: extractObjectMemberName(file) };
        }
    }

    for (const r of mapping.folderBased) {
        if (file.includes(r.dir) && file.endsWith(r.ext)) {
            return { type: r.type, name: extractFolderMemberName(file) };
        }
    }

    if (file.includes("/staticresources/")) {
        const f = parts[parts.indexOf("staticresources") + 1].split(".")[0];
        return { type: "StaticResource", name: f };
    }

    return null;
}

function extractFolderMemberName(file) {
    const target = file.split("/").slice(4);
    target[target.length - 1] = target[target.length - 1].replace(/\.([a-zA-Z]+-)?meta\.xml$/, "");
    return target.join("/");
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

function getTargetOrg() {
    return ` -o ${TARGET_ORG} `;
}

function showHelp() {
    const targetOrg = `${TARGET_ORG_FLAG} | ${TARGET_ORG_FLAG_SHORT} <targetOrg>`;
    const branch = `${BRANCH_FLAG} | ${BRANCH_FLAG_SHORT} <branch>`;
    const retrieveOnly = `${RETRIEVE_ONLY_FLAG} | ${RETRIEVE_ONLY_FLAG_SHORT}`;
    const deploy = `${DEPLOY_FLAG} | ${DEPLOY_FLAG_SHORT} <changeSetName>`;

    console.log(`
        ====================================================
        sfPackageDiffer CLI - Salesforce Metadata Tool
        ====================================================
        
        Usage:
          node index.js ${branch} ${targetOrg}  Generate package-diff.xml containing metadata differences between current branch and target branch
          node index.js ${branch} ${targetOrg} ${retrieveOnly}  Retrieve only metadata that is different between current branch and target branch
          node index.js ${branch} ${targetOrg} ${deploy}  Retrieve, update, zip, and deploy metadata for the specified change set
          node index.js ${retrieveOnly}   Retrieve metadata based on existing package-diff.xml
        
        Flags:
          ${BRANCH_FLAG}, ${BRANCH_FLAG_SHORT}     Specify a Git branch to compare with the current branch
          ${RETRIEVE_ONLY_FLAG}, ${RETRIEVE_ONLY_FLAG_SHORT}   Retrieve metadata from Salesforce based on branches difference
          ${DEPLOY_FLAG}, ${DEPLOY_FLAG_SHORT}     Name of the change set to populate
          ${TARGET_ORG_FLAG},    Specify a Salesforce org to deploy to
          ${HELP_FLAG}, ${HELP_FLAG_SHORT}       Show help message
        
        Examples:
          node index.js ${TARGET_ORG_FLAG_SHORT} mySfOrg ${BRANCH_FLAG_SHORT} develop                    Generate package-diff.xml containing metadata differences between current branch and target branch
          node index.js ${TARGET_ORG_FLAG_SHORT} mySfOrg ${BRANCH_FLAG_SHORT} develop ${RETRIEVE_ONLY_FLAG_SHORT}                 Retrieve only metadata that is different between current branch and target branch
          node index.js ${TARGET_ORG_FLAG_SHORT} mySfOrg ${BRANCH_FLAG_SHORT} develop ${DEPLOY_FLAG_SHORT} MyChangeSet     Retrieve, update, zip, and deploy metadata for the specified change set
          node index.js ${TARGET_ORG_FLAG_SHORT} mySfOrg ${RETRIEVE_ONLY_FLAG_SHORT}                            Retrieve metadata based on existing package-diff.xml
        
        Notes:
        - The tool will generate a package-diff.xml file for changed metadata.
        - It will retrieve metadata into a temporary folder (retrievedSource).
        - Deploys are done via the Salesforce CLI (sf).
        - All temporary files are cleaned after deployment.
        
        ====================================================
    `);
    process.exit(0);
}
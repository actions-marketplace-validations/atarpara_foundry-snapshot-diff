const core = require('@actions/core');
const exec = require('@actions/exec');
const { context, getOctokit } = require('@actions/github');
const fs = require('fs');

async function run() {
    try {
        const freshSnapshot = core.getInput('fresh-snapshots') === 'true';
        const includeFuzzTests = core.getInput('include-fuzz-tests') === 'true';
        const includeNewContracts = core.getInput('include-new-contracts') === 'true';
        const foundryProfile = core.getInput('foundry-profile');

        const token = process.env.GITHUB_TOKEN || core.getInput('token');
        if (!token) {
            throw new Error('No GitHub token provided. Set GITHUB_TOKEN or the "token" input.');
        }
        const octokit = getOctokit(token);

        if (!context.payload.pull_request) {
            throw new Error('This action only runs on pull_request events.');
        }

        const { owner, repo } = context.repo;
        const pr = context.payload.pull_request;
        const genCommit = pr.head.sha;
        const comCommit = pr.base.sha;

        const headRepoFullName = pr.head.repo.full_name;
        const headBranch = pr.head.ref;
        const headOwner = pr.head.repo.owner.login;
        const headRepoName = pr.head.repo.name;

        const baseRepoFullName = pr.base.repo.full_name;
        const baseBranch = pr.base.ref;

        if (freshSnapshot) {
            await runGrouped(`Generating .gas-snapshot from "${headBranch}"`, () =>
                generateGasSnapshot(headRepoFullName, headBranch, '.gas-snapshot.pr', foundryProfile),
            );
            await runGrouped(`Generating .gas-snapshot from "${baseBranch}"`, () =>
                generateGasSnapshot(baseRepoFullName, baseBranch, '.gas-snapshot.base', foundryProfile),
            );
        } else {
            await runGrouped(`Reading .gas-snapshot from "${headBranch}"`, async () => {
                const snap = await getGitFileContent(octokit, headOwner, headRepoName, headBranch, '.gas-snapshot');
                fs.writeFileSync('.gas-snapshot.pr', snap);
            });
            await runGrouped(`Reading .gas-snapshot from "${baseBranch}"`, async () => {
                const snap = await getGitFileContent(octokit, owner, repo, baseBranch, '.gas-snapshot');
                fs.writeFileSync('.gas-snapshot.base', snap);
            });
        }

        const diffSnapshot = await runGrouped('Diffing gas snapshots', getDiffFileContent);

        await runGrouped('Generating report', async () => {
            const report = generateReport(diffSnapshot, genCommit, comCommit, includeFuzzTests, includeNewContracts);
            core.info(`Generated report:\n${report}`);
            core.setOutput('markdown', report);
        });
    } catch (error) {
        core.setFailed(`Action failed: ${error.message}`);
    }
}

async function runGrouped(name, fn) {
    core.startGroup(name);
    try {
        return await fn();
    } finally {
        core.endGroup();
    }
}

async function getGitFileContent(octokit, owner, repo, ref, filePath) {
    const response = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
    if (Array.isArray(response.data)) {
        throw new Error(`Expected a file at ${filePath} on ${owner}/${repo}@${ref}, got a directory.`);
    }
    if (!response.data || typeof response.data.content !== 'string') {
        throw new Error(`No content for ${filePath} on ${owner}/${repo}@${ref}.`);
    }
    return Buffer.from(response.data.content, 'base64').toString();
}

async function generateGasSnapshot(repoFullName, branchName, fileName, foundryProfile) {
    const isFork = repoFullName !== `${context.repo.owner}/${context.repo.repo}`;

    core.info(`Fetching branch: ${branchName} from repo: ${repoFullName}`);
    if (foundryProfile) core.info(`Using FOUNDRY_PROFILE=${foundryProfile}`);

    await exec.exec('git', ['checkout', '-B', `temp-${branchName}`]);

    if (isFork) {
        /// clean the remote/fork first then add into fork
        await exec.exec('git', ['remote', 'remove', 'fork'], { ignoreReturnCode: true, silent: true });
        await exec.exec('git', ['remote', 'add', 'fork', `https://github.com/${repoFullName}.git`]);
        await exec.exec('git', ['fetch', 'fork', branchName]);
        await exec.exec('git', ['reset', '--hard', `fork/${branchName}`]);
    } else {
        await exec.exec('git', ['fetch', 'origin', branchName]);
        await exec.exec('git', ['reset', '--hard', `origin/${branchName}`]);
    }

    const env = {
        ...process.env,
        ...(foundryProfile && foundryProfile !== 'default' ? { FOUNDRY_PROFILE: foundryProfile } : {}),
    };

    const code = await exec.exec('forge', ['snapshot', '--snap', fileName], { env });
    if (code !== 0 || !fs.existsSync(fileName) || fs.statSync(fileName).size === 0) {
        throw new Error(
            `forge snapshot failed (exit ${code}) on branch=${branchName}` +
            `${foundryProfile ? `, profile=${foundryProfile}` : ''}.`
        );
    }
}

async function getDiffFileContent() {
    let output = '';
    let stderr = '';
    const code = await exec.exec('diff', ['.gas-snapshot.base', '.gas-snapshot.pr'], {
        ignoreReturnCode: true,
        silent: true,
        listeners: {
            stdout: (data) => {
                const s = data.toString();
                // Bug fix: core.info takes ONE string. Original passed two args; the second was silently dropped.
                core.info(`diff stdout: ${s.trimEnd()}`);
                output += s;
            },
            stderr: (data) => { stderr += data.toString(); },
        },
    });
    // diff exit codes: 0 = identical, 1 = differs (normal), >=2 = real error
    if (code > 1) {
        throw new Error(`diff failed (exit ${code}): ${stderr.trim()}`);
    }
    return output;
}

function generateReport(diffSnapshot, genCommit, comCommit, includeFuzzTests, includeNewContracts) {
    if (!diffSnapshot || diffSnapshot.trim() === '') return '';

    // Bug fix: original built two arrays then did .find() per unique test, giving O(n^2) lookups.
    // Maps are O(1) per lookup.
    const mainByTest = new Map();
    const prByTest = new Map();

    for (const rawLine of diffSnapshot.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (!line.startsWith('<') && !line.startsWith('>')) continue;

        const isFuzzTest = line.includes('runs:');
        if (!includeFuzzTests && isFuzzTest) continue;

        const testName = line.split(' (')[0].substring(2);
        const sep = (isFuzzTest || !line.includes('gas:')) ? '~: ' : 'gas: ';
        const gasValue = line.split(sep)[1]?.replace(')', '').trim();
        if (!testName || !gasValue) continue;

        (line.startsWith('<') ? mainByTest : prByTest).set(testName, gasValue);
    }

    if (mainByTest.size === 0 && prByTest.size === 0) return '';

    const allNames = new Set([...mainByTest.keys(), ...prByTest.keys()]);

    const testData = [];
    for (const fullName of allNames) {
        const [contractName, simpleTestName] = fullName.split(':');
        const mainGas = mainByTest.get(fullName) ?? '-';
        const prGas = prByTest.get(fullName) ?? '-';
        // Bug fix: parseInt without radix can mis-parse strings like "0x..." or "07".
        const diff = (mainGas !== '-' && prGas !== '-')
            ? (parseInt(prGas, 10) - parseInt(mainGas, 10))
            : '-';

        const isNew = diff === '-';
        if (diff === 0) continue;
        if (!includeNewContracts && isNew) continue;

        testData.push({ contractName, testName: simpleTestName, mainGas, prGas, diff });
    }

    if (testData.length === 0) return '';

    testData.sort((a, b) => a.contractName.localeCompare(b.contractName));

    const contractCounts = new Map();
    for (const e of testData) {
        contractCounts.set(e.contractName, (contractCounts.get(e.contractName) ?? 0) + 1);
    }

    let report = `
### Gas Snapshot Comparison Report

> Generated at commit : ${genCommit}, Compared to commit : ${comCommit}

<table>
    <tr>
        <th>Contract Name</th>
        <th>Test Name</th>
        <th>Main Gas</th>
        <th>PR Gas</th>
        <th>Diff</th>
    </tr>`;

    let lastContractName = '';
    for (const entry of testData) {
        if (entry.contractName !== lastContractName) {
            report += `
    <tr>
        <td rowspan="${contractCounts.get(entry.contractName)}">${entry.contractName}</td>`;
        } else {
            report += `
    <tr>`;
        }
        report += `
        <td>${entry.testName}</td>
        <td>${entry.mainGas}</td>
        <td>${entry.prGas}</td>
        <td>${entry.diff}</td>
    </tr>`;
        lastContractName = entry.contractName;
    }

    report += `
</table>
`;
    return report;
}

run();
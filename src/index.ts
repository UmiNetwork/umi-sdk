import { bcs } from '@mysten/bcs';
import * as ChildProcess from 'child_process';
import fs from 'fs';
import { TASK_COMPILE_GET_COMPILATION_TASKS } from 'hardhat/builtin-tasks/task-names';
import { subtask, types } from 'hardhat/config';
import { Artifacts } from 'hardhat/internal/artifacts';
import path from 'path';

import type { Artifact } from 'hardhat/types/artifacts';

const UMI_SERIALIZER = bcs.enum('ScriptOrDeployment', {
  Script: bcs.byteVector(),
  Module: bcs.vector(bcs.byteVector()),
  EvmContract: bcs.byteVector(),
});

async function executeChildProcess(cmd: string): Promise<[ChildProcess.ExecException | null, string, string]> {
  return new Promise((resolve, _reject) => {
    const proc = ChildProcess.exec(cmd, (err, stdout, stderr) => {
      resolve([err, stdout, stderr]);
    });
    proc.stdin!.end();
  });
}

async function isMovePackage(packagePath: fs.PathLike): Promise<boolean> {
  const stats: fs.Stats = await fs.promises.stat(packagePath);

  if (stats.isDirectory()) {
    const manifestPath = path.join(packagePath.toString(), 'Move.toml');
    const manifestStats: fs.Stats = await fs.promises.stat(manifestPath);

    return manifestStats.isFile();
  }
  return false;
}

async function listMovePackages(contractsPath: fs.PathLike): Promise<Array<String>> {
  const dirs: String[] = fs.readdirSync(contractsPath);

  const promises: Promise<String | null>[] = dirs.map(async (name, _idx, _arr) => {
    const packagePath = path.join(contractsPath.toString(), name.toString());
    const isMove = await isMovePackage(packagePath);
    return isMove ? packagePath : null;
  });

  return (await Promise.all(promises)).filter((path): path is String => path !== null);
}

async function locateMoveExecutablePath(): Promise<string> {
  const [e, stdout, _stderr] = await executeChildProcess('which aptos');
  if (e !== null) throw new Error('Failed to locate the `move executable`');

  console.assert(stdout !== '');
  const lines: string[] = stdout.split(/\r?\n/);
  return lines[0];
}

async function movePackageBuild(movePath: string, packagePath: string): Promise<void> {
  // Rebuild every time, so clean up the build folder. `assume-no` is to keep the package cache at ~/.move
  const cleanCmd = `${movePath} move clean --package-dir ${packagePath} --assume-no`;
  let [e, stdout, stderr] = await executeChildProcess(cleanCmd);
  if (e !== null) throw new Error(`Failed to clean the build folder: ${stdout} ${stderr}`);

  // Create a build file with metadata and bytecodes for module bundle
  const outputFile = path.join(packagePath, 'build', 'bundle.json');
  const buildCmd = `${movePath} move build-publish-payload --json-output-file ${outputFile} --package-dir ${packagePath} --skip-fetch-latest-git-deps`;

  [e, stdout, stderr] = await executeChildProcess(buildCmd);
  console.log(stdout);
  if (e !== null) throw new Error(`Failed to build the package: ${stdout} ${stderr}`);
}

async function loadBundle(packagePath: string): Promise<string> {
  const bundlePath = path.join(packagePath, 'build', 'bundle.json');
  const bundleFile = fs.readFileSync(bundlePath, { encoding: 'utf8' });
  const jsonData = JSON.parse(bundleFile);
  if (jsonData?.args?.length < 2 || !jsonData?.args[1].value)
    throw new Error('Missing Move package bundle in the build file');
  const bundleValues: string[] = jsonData?.args[1].value;

  const bundle = bundleValues.map((module) => {
    const bytes = module.startsWith('0x') ? module.substring(2) : module;
    return Uint8Array.from(Buffer.from(bytes, 'hex'));
  });

  // Module bundle bytes are serialized within the higher level enum
  const serialized = UMI_SERIALIZER.serialize({ Module: bundle }).toBytes();
  return '0x' + Buffer.from(serialized).toString('hex');
}

async function generateArtifactForPackage(hardhatRootPath: string, packagePath: string): Promise<Artifact> {
  let bytecode = await loadBundle(packagePath);
  if (!bytecode.startsWith('0x')) bytecode = '0x' + bytecode;

  const sourceName = path.relative(hardhatRootPath, packagePath);
  const contractName = sourceName.replace('contracts/', '');

  const artifact: Artifact = {
    _format: 'hh-move-artifact-1',
    contractName,
    sourceName,
    // TODO: Generate and include ABIs in the contract artifact
    abi: [],
    bytecode,
    deployedBytecode: bytecode,
    linkReferences: {},
    deployedLinkReferences: {},
  };
  return artifact;
}

async function buildPackageAndGenerateArtifact(
  hardhatRootPath: string,
  packagePath: string,
): Promise<Artifact> {
  const movePath = await locateMoveExecutablePath();
  await movePackageBuild(movePath, packagePath);

  let artifact = await generateArtifactForPackage(hardhatRootPath, packagePath);
  console.log(`Successfully built ${packagePath}`);
  return artifact;
}

/***************************************************************************************
 *
 *   Move Compile Subtask (Entrypoint)
 *
 *   This adds a new subtask "compile:move" which is added to the queue when one runs
 *   `npx hardhat compile`. This task will build all the move contracts using the `move`
 *   executable and generate the artifacts hardhat requires for testing and deployment.
 *
 **************************************************************************************/
const TASK_COMPILE_MOVE: string = 'compile:move';

subtask(TASK_COMPILE_GET_COMPILATION_TASKS, async (_, __, runSuper): Promise<string[]> => {
  const otherTasks = await runSuper();
  return [...otherTasks, TASK_COMPILE_MOVE];
});

subtask(TASK_COMPILE_MOVE)
  .addParam('quiet', undefined, undefined, types.boolean)
  .setAction(async (_: { quiet: boolean }, { artifacts, config }) => {
    const packagePaths: String[] = await listMovePackages(path.join(config.paths.root, 'contracts'));

    if (packagePaths.length == 0) {
      console.log('No Move contracts to compile');
      return;
    }

    const plural = packagePaths.length == 1 ? '' : 's';
    console.log('Building %d Move package%s...', packagePaths.length, plural);

    const buildResults = await Promise.all(
      packagePaths.map((path) => buildPackageAndGenerateArtifact(config.paths.root, path.toString())),
    );

    console.assert(packagePaths.length == buildResults.length);
    for (const idx in packagePaths) {
      const packagePathRel = path.relative(config.paths.root, packagePaths[idx].toString());
      const artifact = buildResults[idx];
      await artifacts.saveArtifactAndDebugFile(artifact);
      (artifacts as Artifacts).addValidArtifacts([
        { sourceName: packagePathRel, artifacts: [artifact.contractName] },
      ]);
    }
  });

module.exports = {};

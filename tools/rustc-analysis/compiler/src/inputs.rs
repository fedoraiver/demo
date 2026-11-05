//! 从编译器的实际读取、依赖集合和输出请求采集三种分析共用的输入证明。
use analysis_contract::{
    ExternInput, InputAlias, InputEnv, InputFile, InputProbe, UnitInputs, normalized,
};
use anyhow::{Context, Result, ensure};
use rustc_hir::def_id::LOCAL_CRATE;
use rustc_middle::ty::TyCtxt;
use rustc_session::{
    config::{ExternLocation, OutFileName, OutputType},
    output::out_filename,
};
use rustc_span::source_map::{FileLoader, RealFileLoader};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub(crate) struct ReadTracker {
    state: Arc<Mutex<ReadState>>,
}

#[derive(Default)]
struct ReadState {
    files: BTreeMap<String, String>,
    aliases: BTreeMap<String, String>,
    read_time: BTreeSet<String>,
    probes: BTreeMap<String, bool>,
    probe_errors: BTreeSet<String>,
}

impl ReadTracker {
    fn record(&self, path: &InputAlias, bytes: &[u8]) -> io::Result<()> {
        self.record_snapshot(path, bytes, true)
    }

    fn record_snapshot(&self, alias: &InputAlias, bytes: &[u8], read_time: bool) -> io::Result<()> {
        let hash = digest(bytes);
        let mut state = self.state.lock().expect("Compiler input tracker poisoned");
        remember_alias(&mut state.aliases, alias)?;
        let path = &alias.resolved;
        if let Some(previous) = state.files.get(path) {
            if previous != &hash {
                return Err(io::Error::other(format!(
                    "Compiler input changed between reads: {path}"
                )));
            }
        } else {
            state.files.insert(path.clone(), hash);
        }
        if read_time {
            state.read_time.insert(path.clone());
        }
        Ok(())
    }

    fn probe(&self, path: &Path, exists: bool) {
        let path = match absolute(path) {
            Ok(path) => path,
            Err(error) => {
                self.state
                    .lock()
                    .expect("Compiler input tracker poisoned")
                    .probe_errors
                    .insert(format!(
                        "Cannot identify compiler path probe {}: {error}",
                        path.display()
                    ));
                return;
            }
        };
        let mut state = self.state.lock().expect("Compiler input tracker poisoned");
        if let Some(previous) = state.probes.insert(path.clone(), exists)
            && previous != exists
        {
            state.probe_errors.insert(format!(
                "Compiler path probe changed during compilation: {path}"
            ));
        }
    }

    pub(crate) fn install(&self, config: &mut rustc_interface::interface::Config) {
        config.file_loader = Some(Box::new(TrackedFileLoader {
            inner: config
                .file_loader
                .take()
                .unwrap_or_else(|| Box::new(RealFileLoader)),
            tracker: self.clone(),
        }));
    }

    /// 宏显式登记的文件可能绕过 FileLoader；展开结束时建立基线，分析结束时再核对。
    pub(crate) fn snapshot_tracked_files(&self, tcx: TyCtxt<'_>) -> Result<()> {
        for path in tcx.sess.file_depinfo.borrow().iter() {
            let path = Path::new(path.as_str());
            if path.is_file() {
                let alias = input_path(path)?;
                let bytes = fs::read(path).with_context(|| {
                    format!("Cannot read tracked compiler input {}", path.display())
                })?;
                self.record_snapshot(&alias, &bytes, false)?;
            }
        }
        Ok(())
    }

    pub(crate) fn collect(&self, tcx: TyCtxt<'_>) -> Result<UnitInputs> {
        let mut inputs = UnitInputs {
            complete: true,
            target: tcx.sess.opts.target_triple.to_string(),
            rustc_options_hash: format!("{:?}", tcx.sess.opts.dep_tracking_hash(false)),
            incremental: tcx.sess.opts.incremental.is_some(),
            ..Default::default()
        };
        let state = self.state.lock().expect("Compiler input tracker poisoned");
        let mut files = state.files.clone();
        let mut read_time = state.read_time.clone();
        let mut aliases = state.aliases.clone();
        let probes = state.probes.clone();
        inputs.gaps.extend(state.probe_errors.iter().cloned());
        drop(state);
        for (path, exists) in probes {
            ensure!(
                Path::new(&path).try_exists()? == exists,
                "Compiler path probe changed after it was observed: {path}"
            );
            inputs.probes.push(InputProbe { path, exists });
        }
        for file in tcx
            .sess
            .source_map()
            .files()
            .iter()
            .filter(|file| file.is_real_file() && !file.is_imported())
        {
            let filename = file.name.prefer_local_unconditionally().to_string();
            let alias = input_path(Path::new(&filename))?;
            remember_alias(&mut aliases, &alias)?;
            let path = alias.resolved;
            if read_time.contains(&path) {
                continue;
            }
            let bytes =
                fs::read(&path).with_context(|| format!("Cannot read compiler source {path}"))?;
            if let Ok(text) = std::str::from_utf8(&bytes) {
                ensure!(
                    file.src_hash.matches(text),
                    "Compiler source changed after it was loaded: {path}"
                );
                read_time.insert(path.clone());
            } else {
                // include_bytes! 的 SourceFile 对非 UTF-8 数据只保留空文本，必须有读取时摘要。
                inputs.gaps.push(format!(
                    "Binary source has no read-time fingerprint: {path}"
                ));
            }
            files.insert(path, digest(&bytes));
        }
        for path in tcx.sess.file_depinfo.borrow().iter() {
            let path = Path::new(path.as_str());
            if !path.is_file() {
                inputs.gaps.push(format!(
                    "Tracked compiler input is not a readable regular file: {}",
                    path.display()
                ));
                continue;
            }
            let alias = input_path(path)?;
            remember_alias(&mut aliases, &alias)?;
            let path = alias.resolved;
            if !read_time.contains(&path) {
                // proc macro 的 tracked_path 只登记路径，展开后的磁盘快照不能证明其实际读取内容。
                inputs.gaps.push(format!(
                    "Tracked compiler input has no read-time content proof: {path}"
                ));
            }
            if !files.contains_key(&path) {
                inputs.gaps.push(format!(
                    "Tracked compiler input was registered after expansion: {path}"
                ));
                files.insert(path.clone(), digest(fs::read(&path)?));
            }
        }
        for (path, expected) in files {
            let actual = digest(
                fs::read(&path).with_context(|| format!("Cannot recheck compiler input {path}"))?,
            );
            ensure!(
                actual == expected,
                "Compiler input changed after it was read: {path}"
            );
            inputs.files.push(InputFile {
                path,
                sha256: expected,
            });
        }
        if inputs.files.is_empty() {
            inputs
                .gaps
                .push("Compiler input proof contains no source files".into());
        }
        let mut environment = BTreeMap::new();
        for (name, value) in tcx.sess.env_depinfo.borrow().iter() {
            let value = value.map(|value| digest(value.as_str().as_bytes()));
            if let Some(previous) = environment.insert(name.to_string(), value.clone()) {
                ensure!(
                    previous == value,
                    "Compiler environment input changed during compilation: {name}"
                );
            }
        }
        inputs.env = environment
            .into_iter()
            .map(|(name, value_sha256)| InputEnv { name, value_sha256 })
            .collect();
        inputs.cfg = tcx
            .sess
            .config
            .iter()
            .map(|(name, value)| (name.to_string(), value.map(|value| value.to_string())))
            .collect();
        inputs.cfg.sort();

        let mut binaries = BTreeSet::new();
        let mut loaded = BTreeMap::<_, Vec<Vec<String>>>::new();
        for &krate in tcx.crates(()) {
            let source = tcx.used_crate_source(krate);
            let paths: Vec<_> = source
                .paths()
                .chain(source.sdylib_interface.iter())
                .map(|path| {
                    let alias = input_path(path)?;
                    remember_alias(&mut aliases, &alias)?;
                    Ok(alias.resolved)
                })
                .collect::<io::Result<_>>()?;
            binaries.extend(paths.iter().cloned());
            loaded
                .entry(tcx.crate_name(krate).to_string())
                .or_default()
                .push(paths);
        }
        for (name, entry) in tcx.sess.opts.externs.iter() {
            let search_path = matches!(
                entry.location,
                ExternLocation::FoundInLibrarySearchDirectories
            );
            let paths = if let Some(paths) = entry.files() {
                paths
                    .map(|path| {
                        let alias = input_path(path.original())?;
                        let loaded = normalized(path.canonicalized())?;
                        if alias.resolved != loaded {
                            return Err(io::Error::other(format!(
                                "Compiler extern path alias changed after resolution: {}",
                                alias.path
                            )));
                        }
                        remember_alias(&mut aliases, &alias)?;
                        Ok(loaded)
                    })
                    .collect::<io::Result<Vec<_>>>()?
            } else if let Some(candidates) = loaded.get(name)
                && candidates.len() == 1
                && !candidates[0].is_empty()
            {
                candidates[0].clone()
            } else {
                inputs.gaps.push(format!(
                    "Search-path extern has no unique loaded library: {name}"
                ));
                vec![]
            };
            binaries.extend(paths.iter().cloned());
            inputs.externs.push(ExternInput {
                name: name.clone(),
                paths,
                private: entry.is_private_dep,
                add_prelude: entry.add_prelude,
                nounused: entry.nounused_dep,
                force: entry.force,
                search_path,
            });
        }
        inputs.binary_paths = binaries.into_iter().collect();
        let outputs = tcx.output_filenames(());
        for &kind in tcx.sess.opts.output_types.keys() {
            let filenames = if kind == OutputType::Exe {
                // 通用 Exe 槽不含库名及平台后缀，使用原生 linker 的同一命名入口。
                tcx.crate_types()
                    .iter()
                    .map(|&crate_type| {
                        out_filename(tcx.sess, crate_type, outputs, tcx.crate_name(LOCAL_CRATE))
                    })
                    .collect()
            } else {
                vec![outputs.path(kind)]
            };
            for filename in filenames {
                match filename {
                    OutFileName::Real(path) => inputs.outputs.push(absolute(&path)?),
                    OutFileName::Stdout => inputs.gaps.push(format!(
                        "Compiler output is not a persistent file: {kind:?}"
                    )),
                }
            }
        }
        inputs.outputs.sort();
        inputs.outputs.dedup();
        if tcx
            .sess
            .opts
            .output_types
            .contains_key(&OutputType::DepInfo)
        {
            match outputs.path(OutputType::DepInfo) {
                OutFileName::Real(path) => {
                    let alias = input_path(&path)?;
                    let bytes = fs::read(path)?;
                    remember_alias(&mut aliases, &alias)?;
                    inputs.dep_info = Some(InputFile {
                        path: alias.resolved,
                        sha256: digest(bytes),
                    });
                }
                OutFileName::Stdout => inputs
                    .gaps
                    .push("Compiler dep-info was emitted to stdout".into()),
            }
        } else {
            inputs
                .gaps
                .push("Compiler invocation did not request dep-info".into());
        }
        for (path, resolved) in aliases {
            let alias = InputAlias { path, resolved };
            verify_alias(&alias)?;
            if alias.path != alias.resolved {
                inputs.aliases.push(alias);
            }
        }
        inputs.complete = inputs.gaps.is_empty();
        Ok(inputs)
    }
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn absolute(path: &Path) -> io::Result<String> {
    Ok(std::path::absolute(path)?
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/"))
}

fn input_path(path: &Path) -> io::Result<InputAlias> {
    Ok(InputAlias {
        path: absolute(path)?,
        resolved: normalized(path)?,
    })
}

fn verify_alias(alias: &InputAlias) -> io::Result<()> {
    if normalized(Path::new(&alias.path))? != alias.resolved {
        return Err(io::Error::other(format!(
            "Compiler path alias changed after it was resolved: {}",
            alias.path
        )));
    }
    Ok(())
}

fn remember_alias(aliases: &mut BTreeMap<String, String>, alias: &InputAlias) -> io::Result<()> {
    verify_alias(alias)?;
    if let Some(previous) = aliases.get(&alias.path) {
        if previous != &alias.resolved {
            return Err(io::Error::other(format!(
                "Compiler path alias changed between observations: {}",
                alias.path
            )));
        }
    } else {
        aliases.insert(alias.path.clone(), alias.resolved.clone());
    }
    Ok(())
}

struct TrackedFileLoader {
    inner: Box<dyn FileLoader + Send + Sync>,
    tracker: ReadTracker,
}

impl FileLoader for TrackedFileLoader {
    fn file_exists(&self, path: &Path) -> bool {
        let exists = self.inner.file_exists(path);
        self.tracker.probe(path, exists);
        exists
    }

    fn read_file(&self, path: &Path) -> io::Result<String> {
        let alias = input_path(path)?;
        let text = self.inner.read_file(path)?;
        self.tracker.record(&alias, text.as_bytes())?;
        Ok(text)
    }

    fn read_binary_file(&self, path: &Path) -> io::Result<Arc<[u8]>> {
        let alias = input_path(path)?;
        let bytes = self.inner.read_binary_file(path)?;
        self.tracker.record(&alias, &bytes)?;
        Ok(bytes)
    }

    fn current_directory(&self) -> io::Result<PathBuf> {
        self.inner.current_directory()
    }
}

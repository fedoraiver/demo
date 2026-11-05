//! 报告按精确调用身份索引；原始报告不可变，复用不改写其生产运行身份。
use analysis_contract::{ANALYSIS_SCHEMA_VERSION, Rule, UnitReport};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) fn inputs_key(unit_key: &str) -> String {
    format!("inputs-{unit_key}")
}

pub(crate) fn file_hash(path: &Path) -> Result<String> {
    let mut input = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn replace(source: &Path, target: &Path) -> Result<()> {
    for delay in [Some(20), Some(40), Some(80), Some(160), Some(320), None] {
        match fs::rename(source, target) {
            Ok(()) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                    )
                    && delay.is_some() =>
            {
                thread::sleep(Duration::from_millis(delay.unwrap()))
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Cannot publish analysis cache {}", target.display())
                });
            }
        }
    }
    unreachable!()
}

fn temporary(target: &Path) -> PathBuf {
    target.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    schema_version: u32,
    configuration: String,
    unit_key: String,
    producer_run: String,
    report_sha256: String,
    proof: Value,
}

pub(crate) struct CachedReport {
    pub report: UnitReport,
    pub proof: Value,
}

pub(crate) struct ReportCache {
    directory: PathBuf,
    configuration: String,
    rule: Rule,
}

impl ReportCache {
    pub fn new(directory: PathBuf, configuration: String, rule: Rule) -> Result<Self> {
        fs::create_dir_all(directory.join("reports"))?;
        fs::create_dir_all(directory.join("units"))?;
        Ok(Self {
            directory,
            configuration,
            rule,
        })
    }

    pub fn load(&self, unit_key: &str) -> Result<Option<CachedReport>> {
        let index = self
            .directory
            .join("units")
            .join(format!("{unit_key}.json"));
        if !index.is_file() {
            return Ok(None);
        }
        let entry: Entry =
            serde_json::from_slice(&fs::read(index)?).context("Invalid analysis cache index")?;
        ensure!(
            entry.schema_version == ANALYSIS_SCHEMA_VERSION
                && entry.configuration == self.configuration
                && entry.unit_key == unit_key,
            "Analysis cache context mismatch"
        );
        ensure!(
            entry.report_sha256.len() == 64
                && entry
                    .report_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "Invalid analysis report reference"
        );
        let filename = self
            .directory
            .join("reports")
            .join(format!("{}.json", entry.report_sha256));
        ensure!(
            file_hash(&filename)? == entry.report_sha256,
            "Analysis cache report bytes changed"
        );
        let report: UnitReport =
            serde_json::from_reader(std::io::BufReader::new(fs::File::open(filename)?))?;
        ensure!(
            report.schema_version == ANALYSIS_SCHEMA_VERSION
                && report.rule == self.rule
                && report.configuration == self.configuration
                && report.run == entry.producer_run
                && report.failure.is_none(),
            "Analysis cache report provenance mismatch"
        );
        Ok(Some(CachedReport {
            report,
            proof: entry.proof,
        }))
    }

    pub fn store(
        &self,
        unit_key: &str,
        source: &Path,
        report: &UnitReport,
        proof: Value,
    ) -> Result<()> {
        ensure!(
            report.schema_version == ANALYSIS_SCHEMA_VERSION
                && report.rule == self.rule
                && report.configuration == self.configuration
                && report.failure.is_none()
                && report.inputs.complete,
            "Cannot cache incomplete or failed analysis report"
        );
        ensure!(
            report.analyzed || unit_key.starts_with("inputs-"),
            "Input-only reports cannot replace rule results"
        );
        let hash = file_hash(source)?;
        let target = self.directory.join("reports").join(format!("{hash}.json"));
        if !target.is_file() || file_hash(&target)? != hash {
            let staged = temporary(&target);
            fs::copy(source, &staged)?;
            ensure!(
                file_hash(&staged)? == hash,
                "Analysis report changed during cache copy"
            );
            replace(&staged, &target)?;
        }
        let entry = Entry {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            configuration: self.configuration.clone(),
            unit_key: unit_key.into(),
            producer_run: report.run.clone(),
            report_sha256: hash,
            proof,
        };
        let bytes = serde_json::to_vec(&entry)?;
        let target = self
            .directory
            .join("units")
            .join(format!("{unit_key}.json"));
        if fs::read(&target).ok().as_deref() != Some(bytes.as_slice()) {
            let staged = temporary(&target);
            fs::write(&staged, bytes)?;
            replace(&staged, &target)?;
        }
        Ok(())
    }
}

/// 锁随进程/句柄释放；不同规则有独立缓存，嵌套检查共用外层持有的锁。
pub(crate) struct AnalysisLock {
    _file: fs::File,
}

impl AnalysisLock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory)?;
        let filename = directory.join("analysis.lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&filename)?;
        file.try_lock()
            .with_context(|| format!("Analysis cache is already in use: {}", filename.display()))?;
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn analysis_lock_is_exclusive_and_released_by_its_guard() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/cache-lock")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        let first = AnalysisLock::acquire(&root).unwrap();
        assert!(AnalysisLock::acquire(&root).is_err());
        drop(first);
        assert!(AnalysisLock::acquire(&root).is_ok());
    }
}

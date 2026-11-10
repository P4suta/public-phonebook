use anyhow::Result;
use delivery::repository::completed;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub struct Repository {
    _directory: tempfile::TempDir,
    pub root: PathBuf,
}

impl Repository {
    pub fn new() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let root = directory.path().to_owned();
        let result = Self {
            _directory: directory,
            root,
        };
        result.git(&["init", "--initial-branch=main"])?;
        result.git(&[
            "remote",
            "add",
            "origin",
            "https://github.com/P4suta/public-phonebook.git",
        ])?;
        result.write("apps/ios/version.txt", "1.0.0\n")?;
        result.write("apps/android/version.txt", "1.0.0\n")?;
        result.write("releases/ios/manifest.json", "{\".\":\"1.0.0\"}\n")?;
        result.write("releases/android/manifest.json", "{\".\":\"1.0.0\"}\n")?;
        result.write(".gitignore", "target/\n")?;
        result.commit()?;
        Ok(result)
    }
    pub fn git(&self, arguments: &[&str]) -> Result<String> {
        let mut command = Command::new("git");
        command
            .current_dir(&self.root)
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Delivery fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(arguments);
        Ok(String::from_utf8(completed(command)?.stdout)?
            .trim()
            .to_owned())
    }
    pub fn write(&self, path: &str, value: &str) -> Result<()> {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
        fs::write(path, value)?;
        Ok(())
    }
    pub fn commit(&self) -> Result<()> {
        self.commit_as("test: prepare the delivery fixture")
    }
    pub fn commit_as(&self, message: &str) -> Result<()> {
        self.git(&["add", "."])?;
        self.git(&["commit", "--quiet", "-m", message])?;
        Ok(())
    }
}

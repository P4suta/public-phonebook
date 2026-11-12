use std::process::Command;

#[test]
fn distribution_entrypoints_refuse_local_execution_before_starting_xcode() {
    for arguments in [
        vec!["prepare-archive", "--build-number", "4201"],
        vec![
            "archive",
            "--signing",
            "ci",
            "--prepared",
            "--build-number",
            "4201",
        ],
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ios-check"));
        command.args(arguments);
        for name in [
            "GITHUB_ACTIONS",
            "GITHUB_EVENT_NAME",
            "GITHUB_REPOSITORY",
            "GITHUB_REF",
            "GITHUB_WORKFLOW_REF",
            "GITHUB_SHA",
        ] {
            command.env_remove(name);
        }
        let output = command
            .output()
            .expect("the distribution controller starts");
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("protected main-branch TestFlight workflow: GITHUB_ACTIONS differs"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

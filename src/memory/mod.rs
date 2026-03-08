/// Memory System
///
/// Persistent storage of lessons, run results, and patterns.
/// v1: JSON file-based. v2: Qdrant vector DB for semantic retrieval.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use crate::vision::VisionObject;
use crate::evaluator::RunEvaluation;

#[derive(Debug, Serialize, Deserialize)]
pub struct RunRecord {
    pub timestamp: u64,
    pub goal: String,
    pub vision_name: String,
    pub overall_score: f32,
    pub passed: bool,
    pub lessons: Vec<String>,
}

fn memory_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".arkos").join("memory.json")
}

pub async fn store_run(goal: &str, vision: &VisionObject, eval: &RunEvaluation) -> Result<()> {
    let path = memory_path();
    std::fs::create_dir_all(path.parent().unwrap())?;

    let mut records: Vec<RunRecord> = load_records().unwrap_or_default();

    let record = RunRecord {
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        goal: goal.to_string(),
        vision_name: vision.name.clone(),
        overall_score: eval.overall_score,
        passed: eval.passed,
        lessons: extract_lessons(eval),
    };

    records.push(record);
    std::fs::write(&path, serde_json::to_string_pretty(&records)?)?;
    println!("💾 Run saved to memory ({} total records)", records.len());

    Ok(())
}

fn load_records() -> Result<Vec<RunRecord>> {
    let path = memory_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn extract_lessons(eval: &RunEvaluation) -> Vec<String> {
    let mut lessons = vec![];
    
    for task_eval in &eval.task_evaluations {
        if task_eval.overall < 0.5 {
            lessons.push(format!("Low score on task {}: {}", task_eval.task_id, task_eval.notes));
        }
    }

    if eval.overall_score < 0.65 {
        lessons.push(format!("Run did not meet threshold (score: {:.2})", eval.overall_score));
    }

    lessons
}

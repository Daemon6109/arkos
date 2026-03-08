/// Execution Pool
///
/// Runs tasks from the task graph using specialized worker models.
/// Independent tasks run in parallel. Results go to the evaluator.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use crate::planner::{TaskGraph, WorkerType};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskResult {
    pub task_id: String,
    pub output: String,
    pub confidence: f32,
    pub worker: String,
}

pub async fn execute_graph(graph: &TaskGraph) -> Result<Vec<TaskResult>> {
    let mut results: Vec<TaskResult> = vec![];
    let mut completed_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut graph = graph.clone();

    loop {
        let ready: Vec<_> = graph.tasks.iter()
            .filter(|t| {
                matches!(t.status, crate::planner::TaskStatus::Pending) &&
                t.depends_on.iter().all(|dep| completed_ids.contains(dep))
            })
            .map(|t| t.id.clone())
            .collect();

        if ready.is_empty() {
            break;
        }

        // Execute ready tasks (in parallel in future, sequential for now)
        for task_id in &ready {
            let task = graph.tasks.iter().find(|t| &t.id == task_id).unwrap().clone();
            println!("  → [{:?}] {}", task.worker, task.description);

            let result = execute_task(&task).await?;
            completed_ids.insert(task_id.clone());

            // Update task status in graph
            if let Some(t) = graph.tasks.iter_mut().find(|t| &t.id == task_id) {
                t.status = crate::planner::TaskStatus::Complete;
            }

            results.push(result);
        }
    }

    Ok(results)
}

async fn execute_task(task: &crate::planner::Task) -> Result<TaskResult> {
    let (model, system_prompt) = worker_config(&task.worker);
    
    let prompt = format!(
        "{}\n\nTask: {}\nContext: {}",
        system_prompt,
        task.description,
        task.context.notes
    );

    let output = call_ollama(&prompt, model).await
        .unwrap_or_else(|e| format!("Worker error: {}", e));

    // Basic confidence heuristic: longer, more structured output = higher confidence
    // Real implementation: use a critic model to score
    let confidence = compute_confidence(&output);

    Ok(TaskResult {
        task_id: task.id.clone(),
        output,
        confidence,
        worker: format!("{:?}", task.worker),
    })
}

fn worker_config(worker: &WorkerType) -> (&'static str, &'static str) {
    match worker {
        WorkerType::CodeGen => (
            "qwen2.5-coder:7b",
            "You are a code generation specialist. Write clean, working code for the given task."
        ),
        WorkerType::Debugger => (
            "mistral:7b",
            "You are a debugging specialist. Identify errors and produce minimal, correct patches."
        ),
        WorkerType::DocWriter => (
            "mistral:7b",
            "You are a documentation specialist. Write clear, concise documentation."
        ),
        WorkerType::TestRunner => (
            "mistral:7b",
            "You are a testing specialist. Write comprehensive tests for the given code."
        ),
        WorkerType::FileOps => (
            "phi3:mini",
            "You are a file operations specialist. Handle file read/write tasks precisely."
        ),
    }
}

fn compute_confidence(output: &str) -> f32 {
    // Naive heuristic — will be replaced by actual critic model scoring
    let len = output.len();
    if len < 50 { return 0.3; }
    if len < 200 { return 0.5; }
    if len < 500 { return 0.7; }
    0.85
}

async fn call_ollama(prompt: &str, model: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false
    });
    let resp = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&body)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    Ok(resp["response"].as_str().unwrap_or("").to_string())
}

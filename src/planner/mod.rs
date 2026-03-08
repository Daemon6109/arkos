/// Planner
///
/// Converts a vision object into an ordered task graph with worker assignments.
/// Tasks have explicit dependencies. Independent tasks can run in parallel.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::vision::VisionObject;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub description: String,
    pub worker: WorkerType,
    pub depends_on: Vec<String>,
    pub context: TaskContext,
    pub status: TaskStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskContext {
    pub files: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum WorkerType {
    CodeGen,
    Debugger,
    DocWriter,
    FileOps,
    TestRunner,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum TaskStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Escalated,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskGraph {
    pub tasks: Vec<Task>,
    pub goal: String,
}

impl TaskGraph {
    pub fn new(goal: &str) -> Self {
        Self {
            tasks: vec![],
            goal: goal.to_string(),
        }
    }

    pub fn add_task(&mut self, description: &str, worker: WorkerType, depends_on: Vec<String>) -> String {
        let id = Uuid::new_v4().to_string();
        self.tasks.push(Task {
            id: id.clone(),
            description: description.to_string(),
            worker,
            depends_on,
            context: TaskContext { files: vec![], notes: String::new() },
            status: TaskStatus::Pending,
        });
        id
    }

    /// Returns tasks whose dependencies are all complete
    pub fn ready_tasks(&self) -> Vec<&Task> {
        self.tasks.iter().filter(|t| {
            t.status == TaskStatus::Pending &&
            t.depends_on.iter().all(|dep_id| {
                self.tasks.iter().any(|d| &d.id == dep_id && d.status == TaskStatus::Complete)
            })
        }).collect()
    }
}

pub async fn plan(vision: &VisionObject) -> Result<TaskGraph> {
    let prompt = build_plan_prompt(vision);
    let response = call_ollama_plan(&prompt).await?;
    parse_task_graph(&response, &vision.name)
}

fn build_plan_prompt(vision: &VisionObject) -> String {
    format!(
        r#"You are a software project planner. Given a product vision, create an ordered task list.

Product: {}
Description: {}
Components: {}
UX Flow: {}

Create a list of concrete development tasks. For each task specify:
- description: what to do
- worker: one of [code_gen, debugger, doc_writer, test_runner]
- depends_on: list of task indices this task depends on (0-indexed, empty if none)

Respond as JSON array:
[
  {{"description": "...", "worker": "code_gen", "depends_on": []}},
  {{"description": "...", "worker": "test_runner", "depends_on": [0]}},
  ...
]"#,
        vision.name,
        vision.description,
        vision.components.join(", "),
        vision.ux_flow.join(" → "),
    )
}

async fn call_ollama_plan(prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "mistral:7b",
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

fn parse_task_graph(response: &str, goal: &str) -> Result<TaskGraph> {
    let mut graph = TaskGraph::new(goal);

    // Extract JSON array from response
    let json_str = extract_json_array(response);
    let tasks_raw: Vec<serde_json::Value> = serde_json::from_str(&json_str)
        .unwrap_or_default();

    // First pass: create tasks and collect ids in order
    let mut task_ids: Vec<String> = vec![];
    for task_val in &tasks_raw {
        let description = task_val["description"].as_str().unwrap_or("unknown task");
        let worker_str = task_val["worker"].as_str().unwrap_or("code_gen");
        let worker = match worker_str {
            "debugger" => WorkerType::Debugger,
            "doc_writer" => WorkerType::DocWriter,
            "test_runner" => WorkerType::TestRunner,
            "file_ops" => WorkerType::FileOps,
            _ => WorkerType::CodeGen,
        };

        let depends_on_indices: Vec<usize> = task_val["depends_on"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect())
            .unwrap_or_default();

        let depends_on_ids: Vec<String> = depends_on_indices.iter()
            .filter_map(|&i| task_ids.get(i).cloned())
            .collect();

        let id = graph.add_task(description, worker, depends_on_ids);
        task_ids.push(id);
    }

    // Fallback: if parsing failed, create a single placeholder task
    if graph.tasks.is_empty() {
        graph.add_task("Analyze requirements and scaffold project", WorkerType::CodeGen, vec![]);
    }

    Ok(graph)
}

fn extract_json_array(text: &str) -> String {
    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            return text[start..=end].to_string();
        }
    }
    "[]".to_string()
}

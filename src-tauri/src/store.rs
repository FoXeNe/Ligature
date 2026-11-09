//! Vault storage: one plain SQLite file that any SQLite tool can open.
//!
//! Every user action arrives as a `Patch` and is applied in a single
//! transaction, so each action is on disk as soon as it happens.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    title   TEXT NOT NULL,
    created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
    id      INTEGER PRIMARY KEY,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    label   TEXT NOT NULL DEFAULT '',
    tags    TEXT NOT NULL DEFAULT '',
    bbox    BLOB NOT NULL,            -- 4 x f32 little-endian: x0 y0 x1 y1
    x       REAL NOT NULL,
    y       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_note ON objects(note_id);

CREATE TABLE IF NOT EXISTS links (
    from_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    to_id   INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL DEFAULT 'ref',
    PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS links_to ON links(to_id);

CREATE TABLE IF NOT EXISTS strokes (
    id        INTEGER PRIMARY KEY,
    note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    object_id INTEGER REFERENCES objects(id) ON DELETE CASCADE,
    data      BLOB NOT NULL           -- packed f32 little-endian triples: x, y, pressure
);
CREATE INDEX IF NOT EXISTS strokes_note ON strokes(note_id);
CREATE INDEX IF NOT EXISTS strokes_object ON strokes(object_id);

CREATE VIRTUAL TABLE IF NOT EXISTS objects_fts USING fts5(
    label, tags, object_id UNINDEXED, note_id UNINDEXED
);
"#;

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct Board {
    pub id: i64,
    pub title: String,
    pub created: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ObjectRow {
    pub id: i64,
    pub note_id: i64,
    pub label: String,
    pub tags: String,
    pub bbox: [f64; 4],
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct LinkRow {
    pub from_id: i64,
    pub to_id: i64,
    pub kind: String,
}

/// A stroke inside a patch. `data` is base64 of the packed f32 triples; patches
/// are small (one user action), while bulk loading uses the binary format below.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StrokeRow {
    pub id: i64,
    pub note_id: i64,
    pub object_id: Option<i64>,
    pub data: String,
}

#[derive(Serialize, Deserialize)]
pub struct Ops<T, D> {
    // An explicit fn avoids serde adding a `T: Default` bound.
    #[serde(default = "Vec::new")]
    pub upsert: Vec<T>,
    #[serde(default = "Vec::new")]
    pub delete: Vec<D>,
}

impl<T, D> Default for Ops<T, D> {
    fn default() -> Self {
        Self {
            upsert: Vec::new(),
            delete: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
pub struct Patch {
    #[serde(default)]
    pub strokes: Ops<StrokeRow, i64>,
    #[serde(default)]
    pub objects: Ops<ObjectRow, i64>,
    #[serde(default)]
    pub links: Ops<LinkRow, LinkRow>,
}

/// Everything about a board except stroke geometry, which goes through `load_strokes`.
#[derive(Serialize)]
pub struct BoardMeta {
    pub objects: Vec<ObjectRow>,
    pub links: Vec<LinkRow>,
}

#[derive(Serialize)]
pub struct Hit {
    pub object_id: i64,
    pub note_id: i64,
    pub label: String,
    pub tags: String,
    pub board_title: String,
}

#[derive(Serialize)]
pub struct GraphNode {
    pub id: i64,
    pub note_id: i64,
    pub label: String,
}

#[derive(Serialize)]
pub struct GraphData {
    pub boards: Vec<Board>,
    pub nodes: Vec<GraphNode>,
    pub links: Vec<LinkRow>,
}

pub struct Vault {
    conn: Connection,
}

impl Vault {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::init(Connection::open(path).map_err(es)?)
    }

    #[cfg(test)]
    fn open_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(es)?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(SCHEMA).map_err(es)?;
        Ok(Self { conn })
    }

    pub fn list_boards(&self) -> Result<Vec<Board>, String> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, title, created FROM notes ORDER BY created, id")
            .map_err(es)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Board {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    created: r.get(2)?,
                })
            })
            .map_err(es)?;
        rows.collect::<Result<_, _>>().map_err(es)
    }

    pub fn create_board(&self, title: &str, now_ms: i64) -> Result<Board, String> {
        self.conn
            .execute(
                "INSERT INTO notes(title, created) VALUES (?1, ?2)",
                params![title, now_ms],
            )
            .map_err(es)?;
        Ok(Board {
            id: self.conn.last_insert_rowid(),
            title: title.to_string(),
            created: now_ms,
        })
    }

    pub fn rename_board(&self, id: i64, title: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE notes SET title = ?1 WHERE id = ?2", params![title, id])
            .map_err(es)?;
        Ok(())
    }

    /// Deletes a board; objects, strokes and links go with it through FK cascades.
    pub fn delete_board(&mut self, id: i64) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(es)?;
        tx.execute("DELETE FROM objects_fts WHERE note_id = ?1", params![id])
            .map_err(es)?;
        tx.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .map_err(es)?;
        tx.commit().map_err(es)
    }

    pub fn load_board(&self, note_id: i64) -> Result<BoardMeta, String> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, note_id, label, tags, bbox, x, y FROM objects WHERE note_id = ?1")
            .map_err(es)?;
        let objects = stmt
            .query_map(params![note_id], |r| {
                let blob: Vec<u8> = r.get(4)?;
                Ok(ObjectRow {
                    id: r.get(0)?,
                    note_id: r.get(1)?,
                    label: r.get(2)?,
                    tags: r.get(3)?,
                    bbox: unpack_bbox(&blob),
                    x: r.get(5)?,
                    y: r.get(6)?,
                })
            })
            .map_err(es)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(es)?;

        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT l.from_id, l.to_id, l.kind FROM links l \
                 JOIN objects o ON o.id = l.from_id WHERE o.note_id = ?1",
            )
            .map_err(es)?;
        let links = stmt
            .query_map(params![note_id], link_row)
            .map_err(es)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(es)?;

        Ok(BoardMeta { objects, links })
    }

    /// All strokes of a board in one binary buffer (see `pack_stroke`).
    /// JSON with base64 would inflate the payload and cost a decode per stroke.
    pub fn load_strokes(&self, note_id: i64) -> Result<Vec<u8>, String> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, object_id, data FROM strokes WHERE note_id = ?1")
            .map_err(es)?;
        let mut rows = stmt.query(params![note_id]).map_err(es)?;
        let mut out = Vec::with_capacity(4096);
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut count: u32 = 0;
        while let Some(r) = rows.next().map_err(es)? {
            let id: i64 = r.get(0).map_err(es)?;
            let object_id: Option<i64> = r.get(1).map_err(es)?;
            let data = r.get_ref(2).map_err(es)?.as_blob().map_err(es)?;
            pack_stroke(&mut out, id, object_id, data);
            count += 1;
        }
        out[0..4].copy_from_slice(&count.to_le_bytes());
        Ok(out)
    }

    /// Applies one action atomically. Removals run first, then object upserts,
    /// so strokes and links never point at missing rows.
    pub fn commit(&mut self, patch: &Patch) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(es)?;
        {
            let mut del_link = tx
                .prepare_cached("DELETE FROM links WHERE from_id = ?1 AND to_id = ?2 AND kind = ?3")
                .map_err(es)?;
            for l in &patch.links.delete {
                del_link.execute(params![l.from_id, l.to_id, l.kind]).map_err(es)?;
            }
            let mut del_stroke = tx.prepare_cached("DELETE FROM strokes WHERE id = ?1").map_err(es)?;
            for id in &patch.strokes.delete {
                del_stroke.execute(params![id]).map_err(es)?;
            }
            let mut del_obj = tx.prepare_cached("DELETE FROM objects WHERE id = ?1").map_err(es)?;
            let mut del_fts = tx
                .prepare_cached("DELETE FROM objects_fts WHERE object_id = ?1")
                .map_err(es)?;
            for id in &patch.objects.delete {
                del_obj.execute(params![id]).map_err(es)?;
                del_fts.execute(params![id]).map_err(es)?;
            }
        }
        for o in &patch.objects.upsert {
            upsert_object(&tx, o)?;
        }
        for s in &patch.strokes.upsert {
            upsert_stroke(&tx, s)?;
        }
        {
            let mut ins_link = tx
                .prepare_cached("INSERT OR IGNORE INTO links(from_id, to_id, kind) VALUES (?1, ?2, ?3)")
                .map_err(es)?;
            for l in &patch.links.upsert {
                ins_link.execute(params![l.from_id, l.to_id, l.kind]).map_err(es)?;
            }
        }
        tx.commit().map_err(es)
    }

    pub fn search(&self, query: &str) -> Result<Vec<Hit>, String> {
        let match_expr = fts_query(query);
        if match_expr.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT o.id, o.note_id, o.label, o.tags, n.title \
                 FROM objects_fts \
                 JOIN objects o ON o.id = objects_fts.object_id \
                 JOIN notes n ON n.id = o.note_id \
                 WHERE objects_fts MATCH ?1 \
                 ORDER BY rank LIMIT 60",
            )
            .map_err(es)?;
        let rows = stmt
            .query_map(params![match_expr], |r| {
                Ok(Hit {
                    object_id: r.get(0)?,
                    note_id: r.get(1)?,
                    label: r.get(2)?,
                    tags: r.get(3)?,
                    board_title: r.get(4)?,
                })
            })
            .map_err(es)?;
        rows.collect::<Result<_, _>>().map_err(es)
    }

    pub fn graph(&self) -> Result<GraphData, String> {
        let boards = self.list_boards()?;
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, note_id, label FROM objects")
            .map_err(es)?;
        let nodes = stmt
            .query_map([], |r| {
                Ok(GraphNode {
                    id: r.get(0)?,
                    note_id: r.get(1)?,
                    label: r.get(2)?,
                })
            })
            .map_err(es)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(es)?;
        let mut stmt = self
            .conn
            .prepare_cached("SELECT from_id, to_id, kind FROM links")
            .map_err(es)?;
        let links = stmt
            .query_map([], link_row)
            .map_err(es)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(es)?;
        Ok(GraphData { boards, nodes, links })
    }
}

fn link_row(r: &rusqlite::Row) -> rusqlite::Result<LinkRow> {
    Ok(LinkRow {
        from_id: r.get(0)?,
        to_id: r.get(1)?,
        kind: r.get(2)?,
    })
}

fn upsert_object(tx: &Transaction, o: &ObjectRow) -> Result<(), String> {
    // ON CONFLICT ... DO UPDATE instead of INSERT OR REPLACE: REPLACE deletes
    // the old row first, which would cascade-delete its strokes and links.
    tx.prepare_cached(
        "INSERT INTO objects(id, note_id, label, tags, bbox, x, y) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(id) DO UPDATE SET \
            note_id = excluded.note_id, label = excluded.label, tags = excluded.tags, \
            bbox = excluded.bbox, x = excluded.x, y = excluded.y",
    )
    .map_err(es)?
    .execute(params![
        o.id,
        o.note_id,
        o.label,
        o.tags,
        pack_bbox(&o.bbox).to_vec(),
        o.x,
        o.y
    ])
    .map_err(es)?;

    tx.prepare_cached("DELETE FROM objects_fts WHERE object_id = ?1")
        .map_err(es)?
        .execute(params![o.id])
        .map_err(es)?;
    tx.prepare_cached("INSERT INTO objects_fts(label, tags, object_id, note_id) VALUES (?1, ?2, ?3, ?4)")
        .map_err(es)?
        .execute(params![o.label, o.tags, o.id, o.note_id])
        .map_err(es)?;
    Ok(())
}

fn upsert_stroke(tx: &Transaction, s: &StrokeRow) -> Result<(), String> {
    let blob = B64.decode(&s.data).map_err(es)?;
    if blob.len() % 12 != 0 {
        return Err(format!("stroke {}: data is not a list of (x, y, pressure) f32 triples", s.id));
    }
    tx.prepare_cached(
        "INSERT INTO strokes(id, note_id, object_id, data) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET \
            note_id = excluded.note_id, object_id = excluded.object_id, data = excluded.data",
    )
    .map_err(es)?
    .execute(params![s.id, s.note_id, s.object_id, blob])
    .map_err(es)?;
    Ok(())
}

/// Binary stroke record, little-endian, every field 4-byte aligned:
/// `f64 id | f64 object_id (-1 = none) | u32 float_count | f32 * float_count`.
/// Ids are below 2^53, so f64 holds them exactly and JS reads them as numbers.
fn pack_stroke(out: &mut Vec<u8>, id: i64, object_id: Option<i64>, data: &[u8]) {
    let floats = (data.len() / 4) as u32;
    out.extend_from_slice(&(id as f64).to_le_bytes());
    out.extend_from_slice(&(object_id.unwrap_or(-1) as f64).to_le_bytes());
    out.extend_from_slice(&floats.to_le_bytes());
    out.extend_from_slice(&data[..floats as usize * 4]);
}

fn pack_bbox(b: &[f64; 4]) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (i, v) in b.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&(*v as f32).to_le_bytes());
    }
    out
}

fn unpack_bbox(blob: &[u8]) -> [f64; 4] {
    let mut out = [0f64; 4];
    if blob.len() == 16 {
        for (i, v) in out.iter_mut().enumerate() {
            let mut b = [0u8; 4];
            b.copy_from_slice(&blob[i * 4..i * 4 + 4]);
            *v = f32::from_le_bytes(b) as f64;
        }
    }
    out
}

/// Turns free text into a safe FTS5 prefix query: every term is quoted,
/// so punctuation in user input cannot break the MATCH syntax.
fn fts_query(input: &str) -> String {
    input
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(id: i64, note: i64, label: &str) -> ObjectRow {
        ObjectRow {
            id,
            note_id: note,
            label: label.into(),
            tags: "t1".into(),
            bbox: [0.0, 0.0, 10.0, 10.0],
            x: 5.0,
            y: 5.0,
        }
    }

    fn floats(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|f| f.to_le_bytes()).collect()
    }

    fn stroke(id: i64, note: i64, object: Option<i64>) -> StrokeRow {
        StrokeRow {
            id,
            note_id: note,
            object_id: object,
            data: B64.encode(floats(&[1.0, 2.0, 0.5])),
        }
    }

    fn link(from: i64, to: i64) -> LinkRow {
        LinkRow {
            from_id: from,
            to_id: to,
            kind: "ref".into(),
        }
    }

    fn stroke_count(v: &Vault, note: i64) -> u32 {
        let buf = v.load_strokes(note).unwrap();
        u32::from_le_bytes(buf[0..4].try_into().unwrap())
    }

    #[test]
    fn bbox_roundtrip() {
        let b = [1.5, -2.0, 3.25, 4.0];
        assert_eq!(unpack_bbox(&pack_bbox(&b)), b);
    }

    #[test]
    fn fts_query_is_quoted() {
        assert_eq!(fts_query("ab \"c"), "\"ab\"* \"\"\"c\"*");
        assert_eq!(fts_query("   "), "");
    }

    #[test]
    fn binary_stroke_format() {
        let mut v = Vault::open_memory().unwrap();
        let n = v.create_board("A", 1).unwrap().id;
        let mut p = Patch::default();
        p.objects.upsert.push(obj(100, n, "A"));
        p.strokes.upsert.push(stroke(7, n, Some(100)));
        p.strokes.upsert.push(stroke(8, n, None));
        v.commit(&p).unwrap();

        let buf = v.load_strokes(n).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
        // header + 2 * (8 + 8 + 4 + 3 * 4)
        assert_eq!(buf.len(), 4 + 2 * 32);
        let mut seen = Vec::new();
        let mut off = 4;
        for _ in 0..2 {
            let id = f64::from_le_bytes(buf[off..off + 8].try_into().unwrap());
            let obj = f64::from_le_bytes(buf[off + 8..off + 16].try_into().unwrap());
            let n = u32::from_le_bytes(buf[off + 16..off + 20].try_into().unwrap());
            assert_eq!(n, 3);
            let x = f32::from_le_bytes(buf[off + 20..off + 24].try_into().unwrap());
            assert_eq!(x, 1.0);
            seen.push((id as i64, obj as i64));
            off += 20 + n as usize * 4;
        }
        seen.sort();
        assert_eq!(seen, vec![(7, 100), (8, -1)]);
    }

    #[test]
    fn rejects_malformed_stroke_data() {
        let mut v = Vault::open_memory().unwrap();
        let n = v.create_board("A", 1).unwrap().id;
        let mut p = Patch::default();
        p.strokes.upsert.push(stroke(1, n, None));
        p.strokes.upsert.push(StrokeRow {
            id: 2,
            note_id: n,
            object_id: None,
            data: B64.encode([0u8; 5]),
        });
        assert!(v.commit(&p).is_err());
        assert_eq!(stroke_count(&v, n), 0, "a failed patch must not be half-applied");
    }

    #[test]
    fn commit_load_and_cascade_delete() {
        let mut v = Vault::open_memory().unwrap();
        let n = v.create_board("A", 1).unwrap().id;

        let mut p = Patch::default();
        p.objects.upsert.push(obj(100, n, "Alpha"));
        p.objects.upsert.push(obj(200, n, "Beta"));
        p.strokes.upsert.push(stroke(300, n, Some(100)));
        p.links.upsert.push(link(100, 200));
        v.commit(&p).unwrap();

        let d = v.load_board(n).unwrap();
        assert_eq!(d.objects.len(), 2);
        assert_eq!(d.links.len(), 1);
        assert_eq!(stroke_count(&v, n), 1);

        // Renaming an object must not cascade-delete its strokes or links.
        let mut p = Patch::default();
        p.objects.upsert.push(obj(100, n, "Alpha renamed"));
        v.commit(&p).unwrap();
        assert_eq!(stroke_count(&v, n), 1, "upsert must not cascade");
        assert_eq!(v.load_board(n).unwrap().links.len(), 1, "upsert must not cascade");

        // Deleting an object removes its links and the strokes it owns.
        let mut p = Patch::default();
        p.objects.delete.push(100);
        v.commit(&p).unwrap();
        let d = v.load_board(n).unwrap();
        assert_eq!(d.objects.len(), 1);
        assert_eq!(d.links.len(), 0, "links must cascade");
        assert_eq!(stroke_count(&v, n), 0, "strokes must cascade");
    }

    #[test]
    fn delete_board_removes_everything() {
        let mut v = Vault::open_memory().unwrap();
        let a = v.create_board("A", 1).unwrap().id;
        let b = v.create_board("B", 2).unwrap().id;
        let mut p = Patch::default();
        p.objects.upsert.push(obj(1, a, "Удаляемый"));
        p.objects.upsert.push(obj(2, b, "Остаётся"));
        p.strokes.upsert.push(stroke(3, a, Some(1)));
        p.links.upsert.push(link(1, 2));
        v.commit(&p).unwrap();

        v.delete_board(a).unwrap();
        assert_eq!(v.list_boards().unwrap().len(), 1);
        assert_eq!(stroke_count(&v, a), 0);
        assert_eq!(v.search("Удаляемый").unwrap().len(), 0, "index cleaned");
        let g = v.graph().unwrap();
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.links.len(), 0, "cross-board link cascades");
    }

    #[test]
    fn search_is_prefix_and_case_insensitive() {
        let mut v = Vault::open_memory().unwrap();
        let n = v.create_board("Work", 1).unwrap().id;
        let mut p = Patch::default();
        p.objects.upsert.push(obj(1, n, "Глава про Лассо"));
        v.commit(&p).unwrap();
        assert_eq!(v.search("лассо").unwrap().len(), 1, "case-insensitive Cyrillic");
        assert_eq!(v.search("гла").unwrap().len(), 1, "prefix search");
        assert_eq!(v.search("t1").unwrap().len(), 1, "tags are indexed");

        let mut p = Patch::default();
        p.objects.upsert.push(obj(1, n, "Другое"));
        v.commit(&p).unwrap();
        assert_eq!(v.search("лассо").unwrap().len(), 0, "old label removed from index");
        assert_eq!(v.search("другое").unwrap()[0].board_title, "Work");

        let mut p = Patch::default();
        p.objects.delete.push(1);
        v.commit(&p).unwrap();
        assert_eq!(v.search("другое").unwrap().len(), 0);
    }
}

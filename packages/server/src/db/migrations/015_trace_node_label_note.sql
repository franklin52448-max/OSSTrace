-- A trace card's own free-text name and note (TraceNode.label / .note, ops set_node_label /
-- set_node_note). Scoped to the trace document: deliberately NOT the labels table, which is the
-- signed-in user's private address book and is never written by a trace edit.
ALTER TABLE trace_nodes ADD COLUMN label TEXT;
ALTER TABLE trace_nodes ADD COLUMN note TEXT;

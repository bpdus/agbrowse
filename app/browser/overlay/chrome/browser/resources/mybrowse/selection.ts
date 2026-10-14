// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

export interface SelectionTicket {
  id: string|null;
  version: number;
}

// Late responses for a session that is no longer selected are dropped by
// checking their ticket against the current selection.
export class SelectionGuard {
  private version_ = 0;
  private id_: string|null = null;

  begin(id: string): SelectionTicket {
    this.id_ = id;
    return {id, version: ++this.version_};
  }

  invalidate(): void {
    this.id_ = null;
    this.version_++;
  }

  current(): SelectionTicket {
    return {id: this.id_, version: this.version_};
  }

  accepts(ticket: SelectionTicket|null|undefined): boolean {
    return !!ticket && ticket.id !== null && ticket.id === this.id_ &&
        ticket.version === this.version_;
  }
}

export const activeSessionSelectionGuard = new SelectionGuard();

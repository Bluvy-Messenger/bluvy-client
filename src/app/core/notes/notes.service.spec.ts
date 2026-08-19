import { TestBed } from '@angular/core/testing';
import { NotesService } from './notes.service';
import { NotesRepository } from './notes.repository';
import { NotesLocalStoreService } from './notes-local-store.service';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';
import type { NoteItem } from './notes.types';

describe('NotesService', () => {
  let service: NotesService;
  let repoSpy: jasmine.SpyObj<NotesRepository>;
  let localStoreSpy: jasmine.SpyObj<NotesLocalStoreService>;
  let secureStorageSpy: jasmine.SpyObj<SecureLocalStorageService>;

  const mockMbkBytes = new Uint8Array(32).fill(7);

  beforeEach(() => {
    repoSpy = jasmine.createSpyObj('NotesRepository', [
      'createRecord',
      'putRecord',
      'deleteRecord',
      'getRecord',
      'listRecords',
    ]);
    localStoreSpy = jasmine.createSpyObj('NotesLocalStoreService', [
      'initialize',
      'close',
      'getAllNotes',
      'getNote',
      'saveNote',
      'saveMany',
      'deleteNote',
      'clearAll',
    ]);
    secureStorageSpy = jasmine.createSpyObj('SecureLocalStorageService', [
      'loadMbk',
      'storeMbk',
      'hasMbk',
      'clearMbk',
    ]);

    localStoreSpy.initialize.and.resolveTo();
    localStoreSpy.getAllNotes.and.resolveTo([]);
    localStoreSpy.saveNote.and.resolveTo();
    localStoreSpy.saveMany.and.resolveTo();
    localStoreSpy.deleteNote.and.resolveTo();
    localStoreSpy.clearAll.and.resolveTo();

    repoSpy.putRecord.and.resolveTo({ uri: 'at://did:plc:test/app.bluvy.note/rkey1', cid: 'bafytest' });
    repoSpy.deleteRecord.and.resolveTo();
    repoSpy.listRecords.and.resolveTo({ records: [] });

    secureStorageSpy.loadMbk.and.resolveTo({
      bytes: new Uint8Array(mockMbkBytes),
      keyGeneration: 1,
    });

    TestBed.configureTestingModule({
      providers: [
        NotesService,
        { provide: NotesRepository, useValue: repoSpy },
        { provide: NotesLocalStoreService, useValue: localStoreSpy },
        { provide: SecureLocalStorageService, useValue: secureStorageSpy },
      ],
    });

    service = TestBed.inject(NotesService);
  });

  it('should initialize and load cached notes', async () => {
    const existing: NoteItem[] = [
      {
        id: 'note-1',
        text: 'Hello world',
        tags: [],
        pinned: false,
        keyGeneration: 1,
        createdAt: 1000,
        updatedAt: 1000,
        syncStatus: 'synced',
      },
    ];
    localStoreSpy.getAllNotes.and.resolveTo(existing);

    await service.initialize('did:plc:user123');

    expect(service.notes().length).toBe(1);
    expect(service.notes()[0]?.text).toBe('Hello world');
    expect(service.latestNote()?.id).toBe('note-1');
  });

  it('should send a new note and update reactive signals', async () => {
    await service.initialize('did:plc:user123');

    const sent = await service.sendNote('New memo for testing');

    expect(sent.text).toBe('New memo for testing');
    expect(service.notes().length).toBe(1);
    expect(localStoreSpy.saveNote).toHaveBeenCalled();
  });

  it('should reject empty note text', async () => {
    await service.initialize('did:plc:user123');

    await expectAsync(service.sendNote('   ')).toBeRejectedWithError('Note text cannot be empty');
  });

  it('should edit an existing note', async () => {
    await service.initialize('did:plc:user123');
    const sent = await service.sendNote('Initial note text');

    await service.editNote(sent.id, 'Updated note content');

    const updated = service.notes().find(n => n.id === sent.id);
    expect(updated?.text).toBe('Updated note content');
  });

  it('should delete a note and invoke PDS deletion', async () => {
    await service.initialize('did:plc:user123');
    const sent = await service.sendNote('To be deleted');

    await service.deleteNote(sent.id);

    expect(service.notes().find(n => n.id === sent.id)).toBeUndefined();
    expect(localStoreSpy.deleteNote).toHaveBeenCalledWith(sent.id);
    expect(repoSpy.deleteRecord).toHaveBeenCalledWith(sent.id);
  });

  it('should toggle pin status of a note', async () => {
    await service.initialize('did:plc:user123');
    const sent = await service.sendNote('Pinnable note');

    expect(sent.pinned).toBe(false);

    await service.togglePin(sent.id);
    expect(service.notes().find(n => n.id === sent.id)?.pinned).toBe(true);

    await service.togglePin(sent.id);
    expect(service.notes().find(n => n.id === sent.id)?.pinned).toBe(false);
  });
});

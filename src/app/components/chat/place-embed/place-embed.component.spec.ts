import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PlaceEmbedComponent } from './place-embed.component';
import type { PlaceData } from '../../../core/place/place.types';
import { TranslationService } from '../../../core/i18n/translation.service';

describe('PlaceEmbedComponent', () => {
  let component: PlaceEmbedComponent;
  let fixture: ComponentFixture<PlaceEmbedComponent>;

  const validPlace: PlaceData = {
    name: 'Mairie de Romilly-sur-Seine',
    osmType: 'way',
    osmId: 228574493,
    latitude: 48.51926,
    longitude: 3.72663,
    zoom: 17.5,
    address: '10100 Romilly-sur-Seine, France',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlaceEmbedComponent],
      providers: [TranslationService],
    }).compileComponents();

    fixture = TestBed.createComponent(PlaceEmbedComponent);
    component = fixture.componentInstance;
  });

  it('should create and render valid place embed with Cartes.app iframe', () => {
    component.place = validPlace;
    fixture.detectChanges();

    expect(component.isValid()).toBe(true);
    expect(component.rawCartesUrl()).toBe(
      'https://cartes.app/?allez=Mairie%20de%20Romilly-sur-Seine|w228574493|3.72663|48.51926#17.5/48.51926/3.72663'
    );
    expect(component.safeCartesUrl()).toBeTruthy();

    const compiled = fixture.nativeElement as HTMLElement;
    const iframe = compiled.querySelector('iframe.place-embed__iframe');
    expect(iframe).toBeTruthy();
    expect(compiled.querySelector('.place-embed__name')?.textContent).toContain('Mairie de Romilly-sur-Seine');
  });

  it('should render fallback when place data is invalid', () => {
    component.place = {
      name: '',
      osmType: 'way',
      osmId: 1,
      latitude: 100, // invalid lat
      longitude: 3.7,
    };
    fixture.detectChanges();

    expect(component.isValid()).toBe(false);
    expect(component.safeCartesUrl()).toBeNull();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('iframe')).toBeNull();
    expect(compiled.querySelector('.place-embed--fallback')).toBeTruthy();
  });

  it('should open Cartes.app in external window when button is clicked', () => {
    component.place = validPlace;
    fixture.detectChanges();

    const openSpy = spyOn(window, 'open');
    const mockEvent = new MouseEvent('click');
    component.openInCartesApp(mockEvent);

    expect(openSpy).toHaveBeenCalledWith(
      'https://cartes.app/?allez=Mairie%20de%20Romilly-sur-Seine|w228574493|3.72663|48.51926#17.5/48.51926/3.72663',
      '_blank',
      'noopener,noreferrer'
    );
  });
});

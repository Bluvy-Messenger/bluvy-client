import { TestBed } from '@angular/core/testing';
import { PhotonService } from './photon.service';

describe('PhotonService', () => {
  let service: PhotonService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [PhotonService],
    });
    service = TestBed.inject(PhotonService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should return empty array for empty query without network call', async () => {
    const fetchSpy = spyOn(window, 'fetch');
    const results = await service.search('   ');
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should search photon API and parse GeoJSON features into PlaceData', async () => {
    const mockResponse = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [3.72663, 48.51926],
          },
          properties: {
            name: 'Mairie de Romilly-sur-Seine',
            osm_type: 'W',
            osm_id: 228574493,
            street: 'Rue de la Boule d\'Or',
            housenumber: '1',
            city: 'Romilly-sur-Seine',
            postcode: '10100',
            country: 'France',
          },
        },
      ],
    };

    spyOn(window, 'fetch').and.resolveTo(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const results = await service.search('Romilly');
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      name: 'Mairie de Romilly-sur-Seine',
      osmType: 'way',
      osmId: 228574493,
      latitude: 48.51926,
      longitude: 3.72663,
      zoom: 17.5,
      address: '1 Rue de la Boule d\'Or, 10100 Romilly-sur-Seine, France',
    });
  });

  it('should handle API errors gracefully', async () => {
    spyOn(window, 'fetch').and.resolveTo(
      new Response('Internal Server Error', {
        status: 500,
      })
    );

    await expectAsync(service.search('Paris')).toBeRejectedWithError(/Photon search failed with HTTP status 500/);
  });
});

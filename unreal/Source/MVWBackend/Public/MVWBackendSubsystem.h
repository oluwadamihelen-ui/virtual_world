// NOT COMPILED YET: written without an Unreal Engine installation. See unreal/README.md.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Dom/JsonObject.h"
#include "MVWBackendSubsystem.generated.h"

/** Result of a backend call. Status is the HTTP status (0 = transport failure). */
struct FMVWBackendResult
{
	int32 Status = 0;
	TSharedPtr<FJsonObject> Json;
	bool Ok() const { return Status >= 200 && Status < 300; }
	FString ErrorCode() const { FString E; return (Json.IsValid() && Json->TryGetStringField(TEXT("error"), E)) ? E : FString(TEXT("transport_error")); }
};
DECLARE_DELEGATE_OneParam(FMVWBackendCallback, const FMVWBackendResult&);

/**
 * Server-side bridge to the MVW backend. Runs ONLY on the dedicated server (clients never get the server key
 * and never talk to the economy API). The backend is the source of truth for MVC, inventory, rent and wages;
 * gameplay code asks it to perform an action and replicates the confirmed result to clients.
 *
 * Config (command line or environment):  -MvwBackendUrl=http://127.0.0.1:3000   MVW_SERVER_KEY=<secret>
 */
UCLASS()
class MVWBACKEND_API UMVWBackendSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;

	/**
	 * Production connection flow: the client sends the join ticket it got from POST /v1/characters/:id/join-ticket.
	 * The result's Json is the character summary (it includes "characterId"). Never trust a characterId sent by a client.
	 */
	void RedeemJoinTicket(const FString& Ticket, FMVWBackendCallback Callback);

	/** Unauthenticated GET /healthz. Used by the `mvw.health` console command. */
	void CheckHealth(FMVWBackendCallback Callback);
	/** GET the Corner Grocery stock (needs MVW_SERVER_KEY). Used by the `mvw.shop` console command. */
	void FetchShop(const FString& ShopId, FMVWBackendCallback Callback);

	/** Dev/test only (the backend disables this route in production): join by bare character id. */
	void JoinCharacter(const FString& CharacterId, FMVWBackendCallback Callback);

	void BusinessPurchase(const FString& CharacterId, const FString& BusinessId, const FString& ItemId, int32 Quantity,
		const FString& IdempotencyKey, FMVWBackendCallback Callback);
	/** Ask the backend whether a chat line may be broadcast. Json has allowed/text/reason. */
	void CheckChat(const FString& CharacterId, const FString& Text, FMVWBackendCallback Callback);
	void IsBlocked(const FString& CharacterA, const FString& CharacterB, FMVWBackendCallback Callback);

	/** Buy from a shop. A fresh idempotency key is generated per player intent; pass the SAME key when retrying. */
	void Purchase(const FString& CharacterId, const FString& ShopId, const FString& ItemId, int32 Quantity,
		const FString& IdempotencyKey, FMVWBackendCallback Callback);

	void RentProperty(const FString& CharacterId, const FString& PropertyId, const FString& IdempotencyKey, FMVWBackendCallback Callback);
	void StartShift(const FString& CharacterId, const FString& JobId, FMVWBackendCallback Callback);
	void CompleteShiftTask(const FString& CharacterId, const FString& ShiftId, FMVWBackendCallback Callback);
	void CompleteShift(const FString& CharacterId, const FString& ShiftId, FMVWBackendCallback Callback);
	void SavePosition(const FString& CharacterId, const FString& District, const FVector& Location);

	static FString NewIdempotencyKey() { return FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower); }

	/**
	 * Generic call used by gameplay code. With an empty BearerToken the request is sent as the game server (x-server-key);
	 * with a token it is sent as that player (Authorization: Bearer), for the player-facing endpoints (login, characters, tickets).
	 */
	void Request(const FString& Verb, const FString& Path, TSharedPtr<FJsonObject> Body, const FString& BearerToken, FMVWBackendCallback Callback);

private:
	void Send(const FString& Verb, const FString& Path, TSharedPtr<FJsonObject> Body, FMVWBackendCallback Callback, const FString& BearerToken = FString());

	FString BaseUrl;
	FString ServerKey;
};
